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

  // --- remove one pair of outer braces if present, then convert newlines ---
  let rawDesc = String(rec.desc || "").trim();
  if (rawDesc.startsWith("{") && rawDesc.endsWith("}")) {
    rawDesc = rawDesc.slice(1, -1).trim();
  }
  const descHtml = rawDesc.replace(/\n/g, "<br/>");

  // --- build clean attachments HTML (no braces) ---
  const filesHtml = files.length
    ? `<ul>${files
        .map(
          (f) =>
            `<li><a href="${pbFileUrl(
              process.env.PB_HOST,
              rec.collectionId,
              rec.id,
              f
            )}" target="_blank" rel="noopener">${f}</a></li>`
        )
        .join("")}</ul>`
    : `<div class="small muted">No files attached.</div>`;

  return {
    id: rec.id,
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
    descHtml, // cleaned description (no outer braces)
    reqNumber: rec.svc_record_number || rec.id,
    service_type: rec.service_type || "—",
    status: rec.status || "New",
    systemName: sys.name || rec.service_for || "—",
    filesHtml, // prebuilt (no braces)
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
      expand: "facility,servicer,system",
    });
    const view = buildServiceRecordView(rec);
    const html = renderTemplate("service_company_page.html", { ...view });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch {
    res.status(404).send("Service request not found.");
  }
});

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

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(
    `Server is running on port ${PORT} host is ${process.env.PB_HOST}`
  );
});
