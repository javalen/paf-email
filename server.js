const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const cors = require("cors");
const PocketBase = require("pocketbase/cjs");
const path = require("path");
const multer = require("multer");

require("dotenv").config();

const { renderTemplate } = require("./lib/renderTemplate");
const { pbFileUrl, fmtD, validateAndFormatPhoneNumber } = require("./lib/fmt");

const app = express();
app.use(bodyParser.json());
app.use(cors());

const pb = new PocketBase(process.env.PB_HOST);
pb.autoCancellation(false);

const upload = multer({ storage: multer.memoryStorage() });

/** Nodemailer transport */
const transporter = nodemailer.createTransport({
  host: "s1099.usc1.mysecurecloudhost.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.TRANSPORT_USER,
    pass: process.env.TRANSPORT_PASS,
  },
});

/** Build email/page data for service record */
function buildServiceRecordView(rec) {
  const fac = rec.expand?.facility || {};
  const svc = rec.expand?.servicer || {};
  const sys = rec.expand?.system || {};

  const files = Array.isArray(rec.attachments)
    ? rec.attachments
    : rec.attachments
    ? [rec.attachments]
    : [];

  // strip a single pair of wrapping braces, then convert newlines
  let rawDesc = String(rec.desc || "").trim();
  if (rawDesc.startsWith("{") && rawDesc.endsWith("}")) {
    rawDesc = rawDesc.slice(1, -1).trim();
  }
  const descHtml = esc(rawDesc).replace(/\n/g, "<br/>");

  // attachments HTML
  const filesHtml = files.length
    ? `<ul>${files
        .map(
          (f) =>
            `<li><a href="${pbFileUrl(
              process.env.PB_HOST,
              rec.collectionId,
              rec.id,
              f
            )}" target="_blank" rel="noopener">${esc(f)}</a></li>`
        )
        .join("")}</ul>`
    : `<div class="small muted">No files attached.</div>`;

  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // comments HTML (from expanded comments)
  const comments = Array.isArray(rec.expand?.comments)
    ? rec.expand.comments
        .slice()
        .sort((a, b) => new Date(a.created) - new Date(b.created))
    : [];

  const commentsHtml =
    comments.length === 0
      ? `<div class="small muted">No comments yet.</div>`
      : comments
          .map(
            (c) => `
    <div class="cmt">
      <div class="cmt-h"><span>${esc(c.user || "—")}</span><span>${fmtD(
              c.created
            )}</span></div>
      <div class="cmt-b">${esc(c.comment || "")}</div>
    </div>`
          )
          .join("");

  return {
    id: rec.id,
    accepted: !!rec.accepted, // <<< needed for UI logic
    status: rec.status || "New", // ensure status present
    createdPretty: fmtD(rec.created),
    facility: {
      name: fac.name || "—",
      address: fac.address || "",
      city: fac.city || "",
      state: fac.state || "",
      zipcode: fac.zipcode || "",
    },
    servicer: {
      name: svc.name || "—",
      address: svc.address || "",
      city: svc.city || "",
      state: svc.state || "",
      zip: svc.zip || "",
      phone: svc.phone || "",
      email: svc.email || "",
    },
    fac_contact_number: rec.fac_contact_number || "",
    descHtml,
    reqNumber: rec.svc_record_number || rec.id,
    service_type: rec.service_type || "—",
    systemName: sys.name || rec.service_for || "—",
    filesHtml,
    commentsHtml, // <<< rendered comments
  };
}

/** Helper: tiny wrapper to send an HTML email rendered from a template */
async function sendHtmlEmail(to, subject, templateName, data) {
  const html = renderTemplate(templateName, data);
  return transporter.sendMail({
    from: "support@predictiveaf.com",
    to,
    subject,
    html,
  });
}

/** -----------------------
 * Admin / verification flows
 * ---------------------- */
const verifyAdminUser = async (email) => {
  try {
    const user = await pb
      .collection("users")
      .getFirstListItem(`email="${email}"`);
    const personel = await pb
      .collection("personel")
      .getFirstListItem(`user="${user.id}" && role="cr"`);
    await pb.collection("personel").update(personel.id, { verified: true });
    return { user };
  } catch (error) {
    console.log(`Error verifying admin user: ${error}`);
    throw error;
  }
};

const sendAdminVerificaitonSuccessEmail = (to, name) => {
  axios
    .post(`${process.env.PAF_MAIL_HOST}/send-admin-verify-success`, {
      to,
      name,
    })
    .catch((error) => {
      console.error("Error sending admin success email", error);
    });
};

// Admin clicks verification link
app.get("/admin", async (req, res) => {
  try {
    const { token } = req.query;
    const { user } = await verifyAdminUser(token);
    sendAdminVerificaitonSuccessEmail(token, user.name);

    const html = renderTemplate("admin_verify_success.html", {
      name: user.name,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send(html);
  } catch {
    res.status(500).send("Unable to verify admin.");
  }
});

// Send admin invite email
app.post("/send-admin-email", async (req, res) => {
  try {
    const { client, to, subject, addedBy, name } = req.body;
    const verificationLink = `${process.env.PAF_MAIL_HOST}/admin?token=${to}`;
    await sendHtmlEmail(to, subject, "admin_added.html", {
      client,
      name,
      addedBy,
      verificationLink,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// Fire-and-forget from /admin handler above
app.post("/send-admin-verify-success", async (req, res) => {
  try {
    const { to, name } = req.body;
    await sendHtmlEmail(
      to,
      "PAF Verification Success!",
      "admin_verify_success.html",
      {
        name,
        PAF_FB_PAGE: process.env.PAF_FB_PAGE,
      }
    );
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

/** -----------------------
 * Generic user / client verification flows
 * ---------------------- */
const acceptRoleInFacility = async (id) => {
  try {
    const record = await pb.collection("new_users").getOne(id, {
      expand: "personel,facility",
    });

    await pb.collection("new_users").update(record.id, { verified: true });
    const personel = await pb
      .collection("personel")
      .update(record.expand.personel.id, { verified: true });

    return {
      name: record.expand.personel.full_name,
      facility: record.expand.facility.name,
    };
  } catch (error) {
    console.log(`Error accepting role ${error}`);
    throw error;
  }
};

app.get("/accept-role", async (req, res) => {
  try {
    const { token } = req.query;
    const { name, facility } = await acceptRoleInFacility(token);
    const html = renderTemplate("verification_accept_role.html", {
      name,
      facility,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send(html);
  } catch {
    res.status(500).send("Unable to accept role.");
  }
});

// New client welcome email
app.post("/send-welcome-email", async (req, res) => {
  try {
    const { client, to, subject, name, host } = req.body;
    const verificationLink = `${process.env.PAF_MAIL_HOST}/verify-email?token=${to}&host=${host}`;
    await sendHtmlEmail(to, subject, "welcome_email.html", {
      client,
      name,
      verificationLink,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

// Verification success page + email trigger
const verifyClient = async (id, backend) => {
  try {
    const client = await backend
      .collection("client")
      .getFirstListItem(`manager="${id}"`);
    return backend.collection("client").update(client.id, { verified: true });
  } catch (error) {
    console.log(`Error verifying Client ${error}`);
    throw error;
  }
};

const verifyUserAndClient = async (email, host) => {
  try {
    const clientpb = new PocketBase(host);
    const user = await clientpb
      .collection("users")
      .getFirstListItem(`email="${email}"`);
    const personel = await clientpb
      .collection("personel")
      .getFirstListItem(`user="${user.id}"`);
    await clientpb
      .collection("personel")
      .update(personel.id, { verified: true });
    const client = await verifyClient(user.id, clientpb);
    return { client, user };
  } catch (error) {
    console.log(`Error verifying User ${error}`);
    throw error;
  }
};

const sendVerificaitonSuccessEmail = (to, name, client) => {
  axios
    .post(`${process.env.PAF_MAIL_HOST}/send-verify-success`, {
      to,
      name,
      client,
    })
    .catch((error) =>
      console.error("Error sending verify success email", error)
    );
};

app.get("/verify-email", async (req, res) => {
  try {
    const { token, host } = req.query;
    const { client, user } = await verifyUserAndClient(token, host);
    sendVerificaitonSuccessEmail(token, user.name, client.name);

    const html = renderTemplate("client_verification_success.html", {
      name: user.name,
      client: client.name,
      PAF_PANEL_HOST: process.env.PAF_PANEL_HOST,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send(html);
  } catch {
    res.status(500).send("Unable to verify email.");
  }
});

app.post("/send-verify-success", async (req, res) => {
  try {
    const { client, to, name } = req.body;
    await sendHtmlEmail(
      to,
      "PAF Verification Success!",
      "client_verification_success.html",
      {
        name,
        client,
        PAF_PANEL_HOST: process.env.PAF_PANEL_HOST,
        PAF_FB_PAGE: process.env.PAF_FB_PAGE,
      }
    );
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

/** -----------------------
 * Personnel/admin onboarding
 * ---------------------- */
app.post("/send-new-user-email", async (req, res) => {
  try {
    const { to, facility, name, client, role, addedBy, newUserId } = req.body;
    const verificationLink = `${process.env.PAF_PANEL_HOST}/cpw/${newUserId}`;
    await sendHtmlEmail(
      to,
      "Welcome to PredictiveAF!",
      "user_added_to_facility.html",
      {
        name,
        client,
        role,
        addedBy,
        facility,
        verificationLink,
        PAF_FB_PAGE: process.env.PAF_FB_PAGE,
      }
    );
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

/** -----------------------
 * Change Password
 * ---------------------- */
app.post("/change-password", async (req, res) => {
  try {
    const { to, name, newUserId } = req.body;
    const verificationLink = `${process.env.PAF_PANEL_HOST}/fpw/${newUserId}`;
    await sendHtmlEmail(
      to,
      "Change Password request for PredictiveAF!",
      "change_password.html",
      {
        name,
        verificationLink,
        PAF_FB_PAGE: process.env.PAF_FB_PAGE,
      }
    );
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.post("/send-new-admin-email", async (req, res) => {
  try {
    const { client, to, name, addedBy, newUserId } = req.body;
    const verificationLink = `${process.env.PAF_PANEL_HOST}/cpw/${newUserId}`;
    await sendHtmlEmail(to, "Welcome to PredictiveAF!", "admin_added.html", {
      client,
      name,
      addedBy,
      verificationLink,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

/** -----------------------
 * Tenant ticketing emails
 * ---------------------- */
app.post("/tenant-ticket-email", async (req, res) => {
  try {
    const { to, subject, tenant, manager, unit, issue, ticket_num, phone } =
      req.body;
    await sendHtmlEmail(to, subject, "tenant_ticket.html", {
      manager,
      tenant,
      unit,
      ticketNum: ticket_num,
      issue,
      formattedPhone: validateAndFormatPhoneNumber(phone),
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.post("/tenant-update-email", async (req, res) => {
  try {
    const { to, subject, tenant, unit, ticketNum, issue, phone, facility } =
      req.body;
    await sendHtmlEmail(to, subject, "tenant_update.html", {
      tenant,
      unit,
      ticketNum,
      issue,
      formattedPhone: validateAndFormatPhoneNumber(phone),
      ticketConsoleUrl: `${process.env.PAF_PANEL_HOST}/tenants`,
      facility,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

app.post("/ticket-comment-email", async (req, res) => {
  try {
    const { to, subject, tenant, unit, ticketNum, comment, phone, facility } =
      req.body;
    await sendHtmlEmail(to, subject, "ticket_comment.html", {
      tenant,
      unit,
      ticketNum,
      comment,
      formattedPhone: validateAndFormatPhoneNumber(phone),
      ticketConsoleUrl: `${process.env.PAF_PANEL_HOST}/tenants`,
      facility,
      PAF_FB_PAGE: process.env.PAF_FB_PAGE,
    });
    res.status(200).send("Email sent");
  } catch (e) {
    res.status(500).send(e.toString());
  }
});

/** -----------------------
 * Service company email + mini-console
 * ---------------------- */
/**
 * POST /email-service-co
 * Body: { record: <service_history with expand>, to?: string }
 */
app.post("/email-service-co", async (req, res) => {
  try {
    const payload = req.body?.record || req.body;
    if (!payload || !payload.id) {
      return res
        .status(400)
        .send("Missing service_history record (id required).");
    }

    const rec = payload.expand
      ? payload
      : await pb.collection("service_history").getOne(payload.id, {
          expand: "facility,servicer,system",
        });

    const to =
      req.body?.to ||
      rec.expand?.servicer?.email ||
      process.env.FALLBACK_SERVICE_EMAIL;

    if (!to)
      return res.status(400).send("No destination email for service company.");

    const pageUrl = `${process.env.PAF_MAIL_HOST.replace(/\/$/, "")}/service/${
      rec.id
    }`;

    const view = buildServiceRecordView(rec);
    const html = renderTemplate("service_email.html", { ...view, pageUrl });

    await sendHtmlEmail(
      to,
      `Service Request ${view.reqNumber} — ${view.facility.name}`,
      "service_email.html",
      {
        ...view,
        pageUrl,
      }
    );

    res.status(200).send("Email sent");
  } catch (err) {
    console.error("email-service-co failed", err);
    res.status(500).send("Internal error sending email.");
  }
});

// Public mini-console page
app.get("/service/:id", async (req, res) => {
  try {
    const rec = await pb.collection("service_history").getOne(req.params.id, {
      // expand comments so they can be displayed
      expand: "facility,servicer,system,comments",
    });
    const view = buildServiceRecordView(rec);
    const html = renderTemplate("service_company_page.html", { ...view });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch {
    res.status(404).send("Service request not found.");
  }
});

// Public mini-console email trigger for document update
app.post("/update-document", async (req, res) => {
  console.log("Received a request");
  try {
    // Body can be either { documentId } or { document: { id: ... } }
    const { document: docFromBody, facilityName, to } = req.body || {};
    const id = req.body.record.id;
    //console.log("documentId", documentId, "TO:", document.contact_email);
    //const id = docFromBody?.id || documentId;
    console.log("ID", req.body || {}, id);
    if (!id) {
      console.log("NO ID");
      return res.status(400).send("Missing document id.");
    }

    // Always re-load from PB so we have collectionId + expand
    const doc = await pb.collection("facility_document").getOne(id, {
      expand: "facility",
    });

    console.log("TO:", doc.contact_email);
    const facility = doc.expand?.facility || {};
    const facilityLabel = facility.name || facilityName || "your facility";

    const fileUrl = doc.file
      ? pbFileUrl(process.env.PB_HOST, doc.collectionId, doc.id, doc.file)
      : null;

    const filesHtml = fileUrl
      ? `<ul><li><a href="${fileUrl}" target="_blank" rel="noopener">${doc.file}</a></li></ul>`
      : `<div class="small muted">No file attached.</div>`;

    // Link to the mini-console page
    const pageUrl = `${
      process.env.PAF_MAIL_HOST?.replace(/\/$/, "") || ""
    }/document-update/${doc.id}`;

    console.log("pageUrl", pageUrl);
    // Use the existing template; it expects {{document}}, {{facility}}, {{id}}, {{filesHtml}}
    const html = renderTemplate("document_upload.html", {
      document: doc,
      facility: { name: facilityLabel },
      id: doc.id,
      filesHtml,
      pageUrl,
    });

    const dest = to || doc.contact_email;

    if (!dest) {
      return res
        .status(500)
        .send(
          "No destination email (contact_email or explicit 'to' required)."
        );
    }

    await transporter.sendMail({
      from: "support@predictiveaf.com",
      to: dest,
      subject: `Document ${doc.name} for ${facilityLabel} is expiring soon`,
      html,
    });

    res.status(200).send("Document update email sent.");
    console.log("Alldone with update-document");
  } catch (err) {
    console.error("update-document failed", err);
    res.status(500).send("Internal error sending document email.");
  }
});

// Public mini-console page for uploading document (shows the form)
app.get("/document-update/:id", async (req, res) => {
  try {
    const doc = await pb
      .collection("facility_documents")
      .getOne(req.params.id, {
        expand: "facility",
      });

    const facility = doc.expand?.facility || {};
    const fileUrl = doc.file
      ? pbFileUrl(process.env.PB_HOST, doc.collectionId, doc.id, doc.file)
      : null;

    const filesHtml = fileUrl
      ? `<ul><li><a href="${fileUrl}" target="_blank" rel="noopener">${doc.file}</a></li></ul>`
      : `<div class="small muted">No file attached.</div>`;

    const html = renderTemplate("document_upload.html", {
      document: doc,
      facility,
      id: doc.id,
      filesHtml,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    console.error("document-update page failed", err);
    res.status(404).send("Document not found.");
  }
});

/**
 * Handles the actual file upload + doc_def linking.
 * This matches the form action: /documentsvc/{{id}}/upload
 */
app.post(
  "/documentsvc/:id/upload",
  upload.single("file"),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const originalId = req.params.id;

      if (!req.file) {
        return res.status(400).send("Missing file.");
      }

      // 1) Get the original facility_document and its doc_def
      const originalDoc = await pb
        .collection("facility_document")
        .getOne(originalId);

      const docDef = await pb
        .collection("facility_doc_def")
        .getFirstListItem(`documents.id="${originalId}"`, {
          expand: "documents",
        });

      // 2) Save the new document to facility_document
      const fd = new FormData();

      // basic fields copied forward; adjust as needed
      fd.append("name", originalDoc.name || "");
      if (originalDoc.effective_date)
        fd.append("effective_date", originalDoc.effective_date);
      if (originalDoc.expire_date)
        fd.append("expire_date", originalDoc.expire_date);
      if (originalDoc.contact_name)
        fd.append("contact_name", originalDoc.contact_name);
      if (originalDoc.contact_number)
        fd.append("contact_number", originalDoc.contact_number);
      if (originalDoc.contact_email)
        fd.append("contact_email", originalDoc.contact_email);
      if (originalDoc.facility) fd.append("facility", originalDoc.facility);
      if (originalDoc.client_id) fd.append("client_id", originalDoc.client_id);

      // reset reminder-related flags on the new doc
      fd.append("expires_soon", "false");
      fd.append("archived", "false");
      fd.append("reminder_sent", "false");
      fd.append("reminder_date", "");

      // handle optional rename from the form
      const desiredName = (req.body?.rename || "").trim();
      const safeBase = desiredName.replace(/[\\/:*?"<>|]+/g, "_").trim();
      const ext = path.extname(req.file.originalname);
      const finalName =
        safeBase.length > 0
          ? safeBase.toLowerCase().endsWith(ext.toLowerCase())
            ? safeBase
            : `${safeBase}${ext}`
          : req.file.originalname;

      fd.append("file", new Blob([req.file.buffer]), finalName);

      const newDoc = await pb.collection("facility_document").create(fd);

      // 3) Update facility_doc_def documents relation
      const currentIds = Array.isArray(docDef.documents)
        ? [...docDef.documents]
        : [];

      if (docDef.multiple_allowed) {
        // add new document alongside existing
        currentIds.push(newDoc.id);
        await pb
          .collection("facility_doc_def")
          .update(docDef.id, { documents: currentIds });
      } else {
        // archive old, replace with new
        try {
          await pb
            .collection("facility_document")
            .update(originalDoc.id, { archived: true });
        } catch (e) {
          console.error("Failed to archive original facility_document", e);
        }

        await pb
          .collection("facility_doc_def")
          .update(docDef.id, { documents: [newDoc.id] });
      }

      // 4) Present success message
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(`
        <html>
          <head>
            <meta charset="utf-8"/>
            <title>Document Updated</title>
            <style>
              body { font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#f3f4f6; padding:40px; }
              .card { max-width:640px; margin:0 auto; background:#fff; border-radius:8px; padding:24px; box-shadow:0 10px 30px rgba(15,23,42,0.15); }
              h1 { font-size:20px; margin-bottom:12px; }
              p { font-size:14px; color:#4b5563; }
              a.btn { display:inline-block; margin-top:16px; padding:8px 16px; border-radius:6px; background:#0f766e; color:#fff; text-decoration:none; font-size:14px; }
            </style>
          </head>
          <body>
            <div class="card">
              <h1>Thank you! Your document has been uploaded.</h1>
              <p>You can safely close this window.</p>
            </div>
          </body>
        </html>
      `);
    } catch (err) {
      console.error("documentsvc upload failed", err);
      res.status(500).send("Failed to upload document.");
    }
  }
);

// Accept request
app.post(
  "/service/:id/accept",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const { name, start_date } = req.body || {};
    if (!name || !start_date)
      return res.status(400).send("Name and Start Date are required.");
    try {
      await pb.collection("service_history").update(req.params.id, {
        accepted: true,
        accepted_by: name,
        svc_start_date: start_date,
        status: "Accepted",
      });
      res.redirect(`/service/${req.params.id}`);
    } catch (e) {
      console.error("Accept failed", e);
      res.status(500).send("Failed to accept request.");
    }
  }
);

// Upload attachment
app.post("/service/:id/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("Missing file.");

    const rec = await pb.collection("service_history").getOne(req.params.id);
    const existing = Array.isArray(rec.attachments)
      ? rec.attachments
      : rec.attachments
      ? [rec.attachments]
      : [];

    const fd = new FormData();
    existing.forEach((fn) => fd.append("attachments", fn));

    const desiredName = (req.body?.rename || "").trim();
    const finalName = desiredName
      ? (() => {
          const base = desiredName.replace(/[\\/:*?"<>|]+/g, "_").trim();
          const ext = path.extname(req.file.originalname);
          return base.toLowerCase().endsWith(ext.toLowerCase())
            ? base
            : `${base}${ext}`;
        })()
      : req.file.originalname;

    fd.append("attachments", new Blob([req.file.buffer]), finalName);

    await pb.collection("service_history").update(req.params.id, fd);
    res.redirect(`/service/${req.params.id}`);
  } catch (e) {
    console.error("Upload failed", e);
    res.status(500).send("Failed to upload file.");
  }
});

// Add comment
app.post(
  "/service/:id/comment",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const text = (req.body?.comment || "").trim();
    if (!text) return res.status(400).send("Comment is required.");
    try {
      const user = "Service Company";
      const com = await pb.collection("service_comment").create({
        comment: text,
        service_id: req.params.id,
        user,
      });
      await pb
        .collection("service_history")
        .update(req.params.id, { "comments+": [com.id] });
      res.redirect(`/service/${req.params.id}`);
    } catch (e) {
      console.error("Comment failed", e);
      res.status(500).send("Failed to add comment.");
    }
  }
);

// Start work: sets status to In Progress, optionally updates/sets start date
app.post(
  "/service/:id/start",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const { name, start_date } = req.body || {};
    if (!name || !start_date) {
      return res.status(400).send("Name and Start Date are required.");
    }
    try {
      await pb.collection("service_history").update(req.params.id, {
        status: "In Progress",
        svc_start_date: start_date,
      });

      try {
        const c = await pb.collection("service_comment").create({
          comment: `Work started; start date set to ${start_date}.`,
          service_id: req.params.id,
          user: name,
        });
        await pb.collection("service_history").update(req.params.id, {
          "comments+": [c.id],
        });
      } catch {}

      res.redirect(`/service/${req.params.id}`);
    } catch (e) {
      console.error("Start failed", e);
      res.status(500).send("Failed to set In Progress.");
    }
  }
);

// Complete work: optional invoice upload + optional warranty creation
app.post(
  "/service/:id/complete",
  upload.single("invoice"),
  async (req, res) => {
    const { name, date, cost, warranty, covered, expires } = req.body || {};
    if (!name || !date)
      return res.status(400).send("Name and Date are required.");

    try {
      // Attach invoice if provided
      if (req.file) {
        const rec = await pb
          .collection("service_history")
          .getOne(req.params.id);
        const existing = Array.isArray(rec.attachments)
          ? rec.attachments
          : rec.attachments
          ? [rec.attachments]
          : [];

        const fd = new FormData();
        existing.forEach((fn) => fd.append("attachments", fn));
        fd.append(
          "attachments",
          new Blob([req.file.buffer]),
          req.file.originalname
        );
        await pb.collection("service_history").update(req.params.id, fd);
      }

      // Optional warranty
      let warrantyId = null;
      if (String(warranty) === "1" && covered && expires) {
        // read current service record to get servicer/company info
        const rec = await pb
          .collection("service_history")
          .getOne(req.params.id, {
            expand: "servicer",
          });
        const servicerId = rec?.servicer || "";
        const servicerName = rec?.expand?.servicer?.name || "";

        const w = await pb.collection("sys_warranty").create({
          company_id: servicerId || "",
          covered: covered,
          start_date: new Date().toString(),
          end_date: new Date(expires).toString(),
          company: servicerName,
          expired: false,
        });
        warrantyId = w.id;
      }

      // complete the service
      const update = {
        status: "Complete",
        svc_end_date: date,
      };
      if (warrantyId) update["warranty"] = warrantyId;
      if (cost !== undefined && cost !== "") {
        const parsed = Number(cost);
        if (!isNaN(parsed) && parsed >= 0) update["cost"] = parsed;
      }
      await pb.collection("service_history").update(req.params.id, update);

      // Add system comment
      try {
        const c = await pb.collection("service_comment").create({
          comment: "Vendor completed work.",
          service_id: req.params.id,
          user: name,
        });
        await pb.collection("service_history").update(req.params.id, {
          "comments+": [c.id],
        });
      } catch {}

      res.redirect(`/service/${req.params.id}`);
    } catch (e) {
      console.error("Complete failed", e);
      res.status(500).send("Failed to complete work.");
    }
  }
);

app.post("/api/reset-by-id/:id", express.json(), async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;
  if (!password || password.length < 8) {
    return res
      .status(400)
      .json({ error: "Password must be at least 8 chars." });
  }

  try {
    // Admin auth — uses env creds; make sure these exist
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);

    await pb.collection("users").update(id, {
      password,
      passwordConfirm: password,
    });

    // (Optional) Invalidate admin session afterwards
    pb.authStore.clear();

    return res.status(204).end();
  } catch (e) {
    console.error("reset-by-id failed", e);
    return res.status(400).json({ error: "Invalid or expired reset link." });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(
    `Server is running on port ${PORT} host is ${process.env.PB_HOST}`
  );
});
