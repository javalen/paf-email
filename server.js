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
const pbMstr = new PocketBase(process.env.PB_MSTR_HOST);
pb.autoCancellation(false);
pbMstr.autoCancellation(false);

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

// ✅ DROP-IN: Newsletter cron endpoint for your existing server.js
// Matches your PB schema exactly for newsletter_issues:
//  - slug, subject, preheader, html, text, status (draft/scheduled/sending/sent), send_at, sent_at, hero_image_url
//
// Assumptions for newsletter_send_log (per your note: no user field needed):
//  - issue (relation -> newsletter_issues)
//  - cr_name (text)
//  - cr_email (text)
//  - status (text/select) like: queued/sent/failed/skipped
//  - error (text)
//  - sent_at (date)
// If your field names differ, adjust ONLY the create() payload in logSendAttempt() below.
//
// Security:
//  - Requires header: X-CRON-SECRET: <CRON_SECRET>
// Env:
//  - CRON_SECRET must be set
//
// Usage:
//  - POST /newsletter/send
//  - Optional: ?dryRun=true  (won't send, won't mark as sent, will not log sends)
//  - Optional: ?limit=50     (cap recipients)
//
// Placeholders you can use inside newsletter_issues.html or newsletter_issues.text:
//  {{cr_name}} {{cr_email}} {{month}} {{year}} {{preheader}} {{hero_image_url}} {{slug}}

function escapeText(s = "") {
  return String(s).replace(/\r/g, "").replace(/\t/g, " ").trim();
}

function dedupeByEmail(rows) {
  const map = new Map();
  for (const r of rows || []) {
    const email = String(r?.cr_email || "")
      .trim()
      .toLowerCase();
    if (!email) continue;
    if (!map.has(email)) map.set(email, r);
  }
  return Array.from(map.values());
}

// --- PB helpers ---
async function getDueIssue() {
  const nowIso = new Date().toISOString();
  await pbMstr
    .collection("_superusers")
    .authWithPassword(
      process.env.PB_MSTR_ADMIN_EMAIL,
      process.env.PB_MSTR_ADMIN_PASS,
    );
  const list = await pbMstr.collection("newsletter_issues").getList(1, 1, {
    filter: `status="scheduled" && send_at <= "${nowIso}"`,
    sort: "send_at",
  });
  return list?.items?.[0] || null;
}

async function setIssue(issueId, patch) {
  await pbMstr
    .collection("_superusers")
    .authWithPassword(
      process.env.PB_MSTR_ADMIN_EMAIL,
      process.env.PB_MSTR_ADMIN_PASS,
    );
  return pbMstr.collection("newsletter_issues").update(issueId, patch);
}

async function getClientReps(limit = 0) {
  await pbMstr
    .collection("_superusers")
    .authWithPassword(
      process.env.PB_MSTR_ADMIN_EMAIL,
      process.env.PB_MSTR_ADMIN_PASS,
    );
  // Pull all clients that have CR email/name present
  const clients = await pbMstr.collection("clients").getFullList({
    filter: `cr_email != ""`,
    //filter: `name="PAF Test Client"`,
    sort: "cr_email",
  });
  const deduped = dedupeByEmail(clients);
  return limit ? deduped.slice(0, limit) : deduped;
}

async function alreadyLogged(issueId, email) {
  const e = String(email || "")
    .trim()
    .toLowerCase();
  if (!e) return true;
  try {
    await pb
      .collection("newsletter_send_log")
      .getFirstListItem(`issue="${issueId}" && cr_email="${e}"`);
    return true;
  } catch {
    return false;
  }
}

async function logSendAttempt({ issueId, cr_name, cr_email, status, error }) {
  try {
    await pbMstr
      .collection("_superusers")
      .authWithPassword(
        process.env.PB_MSTR_ADMIN_EMAIL,
        process.env.PB_MSTR_ADMIN_PASS,
      );
    return await pbMstr.collection("newsletter_send_log").create({
      issue: issueId,
      cr_name: cr_name || "",
      cr_email: String(cr_email || "")
        .trim()
        .toLowerCase(),
      status,
      error: error ? String(error).slice(0, 5000) : "",
      sent_at: status === "sent" ? new Date().toISOString() : "",
    });
  } catch (e) {
    console.error("Failed to write newsletter_send_log", e);
  }
}

// -----------------------------------
// ✅ NEW ENDPOINT: POST /newsletter/send
// -----------------------------------
app.get("/newsletter/send", async (req, res) => {
  const limit = Number(req.query?.limit || 0) || 0;
  const dryRun = String(req.query?.dryRun || "").toLowerCase() === "true";

  try {
    const issue = await getDueIssue();
    if (!issue)
      return res.status(200).json({ ok: true, message: "No due issue." });

    // Lock issue
    await setIssue(issue.id, { status: "sending" });

    const subject = escapeText(issue.subject || "Predictaf Newsletter");
    const preheader = escapeText(issue.preheader || "");
    const slug = escapeText(issue.slug || "");
    const hero_image_url = escapeText(issue.hero_image_url || "");

    const recipients = await getClientReps(limit);

    const now = new Date();
    const month = now.toLocaleString("en-US", { month: "long" });
    const year = String(now.getFullYear());

    let sent = 0;
    let skipped = 0;
    let failed = 0;

    for (const c of recipients) {
      const cr_email = String(c.cr_email || "").trim();
      const cr_name = String(c.cr_name || "").trim();

      if (!cr_email) {
        skipped++;
        continue;
      }

      // Idempotent: skip if already logged
      if (await alreadyLogged(issue.id, cr_email)) {
        skipped++;
        continue;
      }

      const vars = {
        cr_name: cr_name || "Client Rep",
        cr_email,
        month,
        year,
        preheader,
        hero_image_url,
        slug,
      };

      try {
        if (!dryRun) {
          await transporter.sendMail({
            from: "support@predictiveaf.com",
            to: cr_email,
            subject,
            html: String(issue.text || "").trim(), // ✅ final HTML only
            text: String(issue.text || "").trim(),
            // ✅ helps some clients; harmless if ignored
          });
        }

        if (!dryRun) {
          await logSendAttempt({
            issueId: issue.id,
            cr_name,
            cr_email,
            status: "sent",
          });
          sent++;
        } else {
          skipped++;
        }
      } catch (e) {
        failed++;
        await logSendAttempt({
          issueId: issue.id,
          cr_name,
          cr_email,
          status: "failed",
          error: e?.message || String(e),
        });
      }
    }

    if (dryRun) {
      // Restore so it can run for real later
      await setIssue(issue.id, { status: "scheduled" });

      return res.status(200).json({
        ok: true,
        dryRun: true,
        issue: { id: issue.id, slug, subject },
        totals: {
          targeted: recipients.length,
          wouldSend: recipients.length - skipped,
          skipped,
          failed,
        },
      });
    }

    // Mark complete
    await setIssue(issue.id, {
      status: "sent",
      sent_at: new Date().toISOString(),
    });

    return res.status(200).json({
      ok: true,
      issue: { id: issue.id, slug, subject },
      totals: { targeted: recipients.length, sent, skipped, failed },
    });
  } catch (err) {
    console.error("/newsletter/send failed", err);

    // Best-effort unlock any issue stuck in "sending"
    try {
      await pbMstr
        .collection("_superusers")
        .authWithPassword(
          process.env.PB_MSTR_ADMIN_EMAIL,
          process.env.PB_MSTR_ADMIN_PASS,
        );
      const stuck = await pbMstr.collection("newsletter_issues").getList(1, 1, {
        filter: `status="sending"`,
        sort: "-updated",
      });
      const maybe = stuck?.items?.[0];
      if (maybe?.id) await setIssue(maybe.id, { status: "scheduled" });
    } catch {}

    return res.status(500).send("Internal error sending newsletter.");
  }
});

/** -----------------------
 * Helpers for vendor-doc analysis
 * ---------------------- */

/**
 * Analyze a service_company record's doc status.
 * Returns { reasons: string[], daysUntil: number|null } where reasons may include:
 *  - "missing_w9"
 *  - "missing_coi"
 *  - "missing_coi_date"
 *  - "invalid_coi_date"
 *  - "coi_expired"
 *  - "coi_expires_soon"
 */
function analyzeVendorDocs(vendor) {
  const reasons = [];
  let daysUntil = null;

  if (!vendor.w9) {
    reasons.push("missing_w9");
  }

  if (!vendor.coi) {
    reasons.push("missing_coi");
  } else {
    if (!vendor.coi_exp_date) {
      reasons.push("missing_coi_date");
    } else {
      const exp = new Date(vendor.coi_exp_date);
      if (Number.isNaN(exp.getTime())) {
        reasons.push("invalid_coi_date");
      } else {
        const now = new Date();
        const msPerDay = 1000 * 60 * 60 * 24;
        const utcTarget = Date.UTC(
          exp.getFullYear(),
          exp.getMonth(),
          exp.getDate(),
        );
        const utcBase = Date.UTC(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
        );
        daysUntil = Math.round((utcTarget - utcBase) / msPerDay);

        if (daysUntil < 0) {
          reasons.push("coi_expired");
        } else if (daysUntil <= 30) {
          reasons.push("coi_expires_soon");
        }
      }
    }
  }

  return { reasons, daysUntil };
}

/**
 * Build an HTML list of issues from reasons[].
 * This matches the pattern we use for {{filesHtml}} (raw HTML inserted into template).
 */
function buildVendorIssuesHtml(reasons, daysUntil) {
  if (!reasons || reasons.length === 0) {
    return `<div class="small muted">All documents are current.</div>`;
  }

  const labels = {
    missing_w9: "W9 document is missing.",
    missing_coi: "Certificate of Insurance (COI) is missing.",
    missing_coi_date: "COI expiration date is missing.",
    invalid_coi_date: "COI expiration date is invalid.",
    coi_expired: "COI has expired.",
    coi_expires_soon:
      daysUntil != null
        ? `COI will expire in ${daysUntil} day(s).`
        : "COI will expire soon (within 30 days).",
  };

  const items = reasons.map((r) => labels[r] || r);
  return `<ul>${items.map((t) => `<li>${t}</li>`).join("")}</ul>`;
}

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

  function esc(s = "") {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

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
              f,
            )}" target="_blank" rel="noopener">${esc(f)}</a></li>`,
        )
        .join("")}</ul>`
    : `<div class="small muted">No files attached.</div>`;

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
        c.created,
      )}</span></div>
      <div class="cmt-b">${esc(c.comment || "")}</div>
    </div>`,
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
    commentsHtml,
    cost: rec.cost ?? "",
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
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
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
      },
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
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
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
    console.log("Sending welcome email to ", to);
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
    console.log("Verify Client");
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
    await clientpb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);

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
      console.error("Error sending verify success email", error),
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
      },
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
      "Welcome to Predictaf!",
      "user_added_to_facility.html",
      {
        name,
        client,
        role,
        addedBy,
        facility,
        verificationLink,
        PAF_FB_PAGE: process.env.PAF_FB_PAGE,
      },
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
      "Change Password request for Predictaf!",
      "change_password.html",
      {
        name,
        verificationLink,
        PAF_FB_PAGE: process.env.PAF_FB_PAGE,
      },
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
    await sendHtmlEmail(to, "Welcome to Predictaf!", "admin_added.html", {
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

    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
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
      },
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
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
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

/**
 * Public mini-console email trigger for document update
 */
app.post("/update-document", async (req, res) => {
  console.log("Received a request");
  try {
    const { document: docFromBody, facilityName, to } = req.body || {};
    const id = req.body.record.id;
    console.log("ID", req.body || {}, id);
    if (!id) {
      console.log("NO ID");
      return res.status(400).send("Missing document id.");
    }

    // Always re-load from PB so we have collectionId + expand
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
    const doc = await pb.collection("facility_documents").getOne(id, {
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
          "No destination email (contact_email or explicit 'to' required).",
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
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
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

    const html = renderTemplate("document_upload_page.html", {
      document: doc,
      facility,
      id: doc.id,
      filesHtml,
      createdPretty: fmtD(new Date()),
      expirePretty: fmtD(doc.expire_date),
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

      await pb
        .collection("_superusers")
        .authWithPassword(
          process.env.PB_ADMIN_EMAIL,
          process.env.PB_ADMIN_PASS,
        );
      // 1) Get the original facility_document and its doc_def
      const originalDoc = await pb
        .collection("facility_documents")
        .getOne(originalId);
      console.log("Got the doc", `documents.id="${originalId}"`);
      const docDef = await pb
        .collection("facility_doc_def")
        .getFirstListItem(`documents ~ "${originalId}"`, {
          expand: "documents",
        });
      console.log("Got the doc_def");
      // 2) Save the new document to facility_document
      const fd = new FormData();
      // reset reminder-related flags on the new doc
      fd.append("expires_soon", "false");
      fd.append("archived", "false");
      fd.append("reminder_sent", "false");
      fd.append("reminder_date", "");
      // Create the new file
      if (req.body?.rename) {
        const desiredName = (req.body?.rename || "").trim();
        const safeBase = desiredName.replace(/[\\/:*?"<>|]+/g, "_").trim();
        console.log("New file name", safeBase);
        fd.append("file", new Blob([req.file.buffer]), safeBase);
        fd.append("name", safeBase);
      } else {
        fd.append("file", new Blob([req.file.buffer]), originalDoc.name);
        fd.append("name", originalDoc.name);
      }

      fd.append("contact_name", req.body.contact_name);
      fd.append("contact_email", req.body.contact_email);
      fd.append("contact_number", req.body.contact_number);
      fd.append("expire_date", req.body.expire_date);
      fd.append("effective_date", new Date().toISOString());
      fd.append("facility", originalDoc.facility);
      fd.append("client_id", originalDoc.client_id);

      if (docDef.multiple_allowed) {
        console.log("Adding new doc as multiple");
        //Archive the original file
        await pb
          .collection("facility_documents")
          .update(originalDoc.id, { archived: true });

        // Create the new file
        if (req.body?.rename) {
          const desiredName = (req.body?.rename || "").trim();
          const safeBase = desiredName.replace(/[\\/:*?"<>|]+/g, "_").trim();
          fd.append("file", new Blob([req.file.buffer]), safeBase);
        } else {
          fd.append("file", new Blob([req.file.buffer]), originalDoc.name);
        }

        //Create the new document
        const newDoc = await pb.collection("facility_documents").create(fd);

        //Update the doc_def
        await pb
          .collection("facility_doc_def")
          .update(docDef.id, { "+documents": newDoc.id });
      } else {
        console.log("Deleting original");
        // Delete the original
        await pb.collection("facility_documents").delete(originalDoc.id);

        console.log("creating new");
        // Create the new file
        const newDoc = await pb.collection("facility_documents").create(fd);

        console.log("Adding to doc_def");
        //Update the doc_def
        await pb
          .collection("facility_doc_def")
          .update(docDef.id, { "+documents": newDoc.id });
      }

      // 4) Present success message
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(`
       <!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Document Updated</title>
  <!-- Optional success redirect after a few seconds:
  <meta http-equiv="refresh" content="5;url=https://www.predictiveaf.com" />
  -->
  <style>
    :root{
      --bg:#f6f7fb;
      --card-bg:#ffffff;
      --card-br:#e5e7eb;
      --muted:#6b7280;
      --ink:#1f2937;
      --primary:#0f766e;
    }

    * { box-sizing:border-box; margin:0; padding:0; }

    body {
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-y: auto;
    }

    .wrap {
      max-width: 640px;
      margin: 40px auto 24px;
      padding: 16px;
      text-align: center;
      flex: 1 0 auto;
    }

    .logo {
      width: 200px;
      max-width: 60%;
      margin: 0 auto 20px;
      display: block;
    }

    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-br);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(15,23,42,0.12);
      padding: 24px 22px 26px;
      text-align: center;
    }

    h1 {
      font-size: 22px;
      margin-bottom: 10px;
    }

    p {
      font-size: 14px;
      color: var(--muted);
      margin-bottom: 6px;
    }

    .cta {
      margin-top: 14px;
    }

    .btn {
      display: inline-block;
      padding: 10px 18px;
      border-radius: 999px;
      background: var(--primary);
      color: #fff;
      text-decoration: none;
      font-size: 14px;
      font-weight: 600;
    }

    .footer {
      flex-shrink: 0;
      text-align: center;
      padding: 12px 16px 20px;
      font-size: 12px;
      color: var(--muted);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <img class="logo" src="https://www.predictiveaf.com/assets/paf-BMFchRbW.png" alt="Predictaf Logo" />

    <div class="card">
      <h1>Thank you! Your document has been uploaded.</h1>
      <p>You can safely close this window.</p>
      <p>If you opened this page from an email, you may now return to your inbox or the Predictaf portal.</p>

      <!-- Optional CTA back to your app/portal -->
      <!--
      <div class="cta">
        <a class="btn" href="https://app.predictiveaf.com">Back to Predictaf</a>
      </div>
      -->
    </div>
  </div>

  <div class="footer">
    Powered by <strong>Predictaf</strong>
  </div>
</body>
</html>


      `);
    } catch (err) {
      console.error("documentsvc upload failed", err);
      res.status(500).send("Failed to upload document.");
    }
  },
);

/** -----------------------
 * NEW: Vendor-doc compliance email + info page
 * ---------------------- */

/**
 * POST /vendor-docs-email
 * Called by the checker service. Body: { record: { id, ... }, reasons, daysUntil }
 */
app.post("/vendor-docs-email", async (req, res) => {
  try {
    const payload = req.body?.record || req.body;
    if (!payload || !payload.id) {
      return res.status(400).send("Missing vendor record (id required).");
    }

    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
    // Always reload from PocketBase to ensure we have the latest vendor info
    const vendor = await pb.collection("service_company").getOne(payload.id);

    if (!vendor.email) {
      return res.status(400).send("Vendor has no email on file.");
    }

    const reasons = req.body.reasons || req.body.reason || [];
    const daysUntil =
      typeof req.body.daysUntil === "number" ? req.body.daysUntil : null;

    const issuesHtml = buildVendorIssuesHtml(reasons, daysUntil);

    const pageUrl = `${process.env.PAF_MAIL_HOST.replace(
      /\/$/,
      "",
    )}/vendor-docs/${vendor.id}`;

    const html = renderTemplate("vendor_docs_notice.html", {
      vendor,
      issuesHtml,
      pageUrl,
    });

    await transporter.sendMail({
      from: "support@predictiveaf.com",
      to: vendor.email,
      subject: "Action needed: Vendor compliance documents for Predictaf",
      html,
    });

    res.status(200).send("Vendor doc email sent.");
  } catch (err) {
    console.error("vendor-docs-email failed", err);
    res.status(500).send("Internal error sending vendor doc email.");
  }
});

/**
 * GET /vendor-docs/:id
 * Simple info page vendors can visit to see what's missing/expiring.
 */
// Show vendor compliance status + upload form
app.get("/vendor-docs/:id", async (req, res) => {
  try {
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
    const vendor = await pb.collection("service_company").getOne(req.params.id);

    const { reasons, daysUntil } = analyzeVendorDocs(vendor);
    const issuesHtml = buildVendorIssuesHtml(reasons, daysUntil);
    const coiExpirePretty = vendor.coi_exp_date
      ? fmtD(vendor.coi_exp_date)
      : "Not on file";

    // Current W9 / COI links (if any)
    const w9FileHtml = vendor.w9
      ? `<a href="${pbFileUrl(
          process.env.PB_HOST,
          vendor.collectionId,
          vendor.id,
          vendor.w9,
        )}" target="_blank" rel="noopener">${vendor.w9}</a>`
      : `<div class="small muted">No W9 on file.</div>`;

    const coiFileHtml = vendor.coi
      ? `<a href="${pbFileUrl(
          process.env.PB_HOST,
          vendor.collectionId,
          vendor.id,
          vendor.coi,
        )}" target="_blank" rel="noopener">${vendor.coi}</a>`
      : `<div class="small muted">No COI on file.</div>`;

    const html = renderTemplate("vendor_docs_page.html", {
      vendor,
      issuesHtml,
      coiExpirePretty,
      createdPretty: fmtD(new Date()),
      w9FileHtml,
      coiFileHtml,
    });

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(html);
  } catch (err) {
    console.error("vendor-docs page failed", err);
    res.status(404).send("Vendor not found.");
  }
});

// Handle vendor W9 / COI upload
app.post(
  "/vendor-docs/:id/upload",
  upload.fields([
    { name: "w9_file", maxCount: 1 },
    { name: "coi_file", maxCount: 1 },
  ]),
  express.urlencoded({ extended: true }),
  async (req, res) => {
    try {
      const vendorId = req.params.id;
      const files = req.files || {};
      const w9File = files.w9_file && files.w9_file[0];
      const coiFile = files.coi_file && files.coi_file[0];
      const coiExpDate = (req.body.coi_exp_date || "").trim();

      if (!w9File && !coiFile && !coiExpDate) {
        return res
          .status(400)
          .send(
            "Please upload a W9, a COI, or update the COI expiration date.",
          );
      }

      // If a new COI file is uploaded, require an expiration date
      if (coiFile && !coiExpDate) {
        return res
          .status(400)
          .send(
            "Please provide a COI expiration date when uploading a COI file.",
          );
      }

      const fd = new FormData();

      if (w9File) {
        fd.append("w9", new Blob([w9File.buffer]), w9File.originalname);
      }

      if (coiFile) {
        fd.append("coi", new Blob([coiFile.buffer]), coiFile.originalname);
      }

      if (coiExpDate) {
        // Store as provided; PocketBase will store it as text/date field
        fd.append("coi_exp_date", coiExpDate);
      }

      // Optional: clear reminder flags when vendor updates docs
      fd.append("reminder_sent", "false");
      fd.append("reminder_date", "");

      await pb.collection("service_company").update(vendorId, fd);

      // Simple success page (same style as document upload success)
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.status(200).send(`
<!doctype html>
<html>
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>Vendor Documents Updated</title>
  <style>
    :root{
      --bg:#f6f7fb;
      --card-bg:#ffffff;
      --card-br:#e5e7eb;
      --muted:#6b7280;
      --ink:#1f2937;
      --primary:#0f766e;
    }
    * { box-sizing:border-box; margin:0; padding:0; }
    body {
      font-family: system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;
      background: var(--bg);
      color: var(--ink);
      min-height: 100vh;
      display:flex;
      flex-direction:column;
      overflow-y:auto;
    }
    .wrap {
      max-width: 640px;
      margin: 40px auto 24px;
      padding: 16px;
      text-align: center;
      flex:1 0 auto;
    }
    .logo {
      width: 200px;
      max-width:60%;
      margin: 0 auto 20px;
      display:block;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-br);
      border-radius: 12px;
      box-shadow: 0 10px 30px rgba(15,23,42,0.12);
      padding: 24px 22px 26px;
      text-align: center;
    }
    h1 { font-size:22px; margin-bottom:10px; }
    p { font-size:14px; color:var(--muted); margin-bottom:6px; }
    .footer {
      flex-shrink:0;
      text-align:center;
      padding:12px 16px 20px;
      font-size:12px;
      color:var(--muted);
    }
  </style>
</head>
<body>
  <div class="wrap">
    <img class="logo" src="https://www.predictiveaf.com/assets/paf-BMFchRbW.png" alt="Predictaf Logo" />
    <div class="card">
      <h1>Thank you! Your documents have been updated.</h1>
      <p>You can safely close this window.</p>
    </div>
  </div>
  <div class="footer">
    Powered by <strong>Predictaf</strong>
  </div>
</body>
</html>
      `);
    } catch (err) {
      console.error("vendor-docs upload failed", err);
      res.status(500).send("Failed to update vendor documents.");
    }
  },
);

// Accept request
app.post(
  "/service/:id/accept",
  express.urlencoded({ extended: true }),
  async (req, res) => {
    const { name, start_date } = req.body || {};
    if (!name || !start_date) {
      return res.status(400).send("Name and Start Date are required.");
    }

    try {
      await pb
        .collection("_superusers")
        .authWithPassword(
          process.env.PB_ADMIN_EMAIL,
          process.env.PB_ADMIN_PASS,
        );

      // ✅ Guard: only allow accept when status is exactly "New"
      const current = await pb
        .collection("service_history")
        .getOne(req.params.id, {
          fields: "id,status,accepted",
        });

      const curStatus = (current?.status || "New").trim();
      if (curStatus !== "New") {
        // Don’t accept again; send them back to the page which now shows the message
        return res.redirect(`/service/${req.params.id}`);
      }

      await pb.collection("service_history").update(req.params.id, {
        accepted: true,
        accepted_by: name,
        svc_start_date: start_date,
        status: "Accepted",
      });

      return res.redirect(`/service/${req.params.id}`);
    } catch (e) {
      console.error("Accept failed", e);
      return res.status(500).send("Failed to accept request.");
    }
  },
);

// Upload attachment
app.post("/service/:id/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).send("Missing file.");
    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
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
      await pb
        .collection("_superusers")
        .authWithPassword(
          process.env.PB_ADMIN_EMAIL,
          process.env.PB_ADMIN_PASS,
        );
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
  },
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
      await pb
        .collection("_superusers")
        .authWithPassword(
          process.env.PB_ADMIN_EMAIL,
          process.env.PB_ADMIN_PASS,
        );
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
  },
);

// Complete work: optional invoice upload + optional warranty creation
app.post(
  "/service/:id/complete",
  upload.single("invoice"),
  async (req, res) => {
    const { name, date, cost, warranty, covered, expires } = req.body || {};
    if (!name || !date)
      return res.status(400).send("Name and Date are required.");

    await pb
      .collection("_superusers")
      .authWithPassword(process.env.PB_ADMIN_EMAIL, process.env.PB_ADMIN_PASS);
    try {
      // Attach invoice if provided
      if (req.file) {
        const rec = await pb
          .collection("service_history")
          .getOne(req.params.id, {
            expand: "servicer,system",
          });
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
          req.file.originalname,
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
            expand: "servicer,system",
          });
        const servicerId = rec?.servicer || "";
        const servicerName = rec?.expand?.servicer?.name || "";

        const w = await pb.collection("sys_warranty").create({
          company_id: servicerId || "",
          covered: covered,
          start_date: new Date().toString(),
          end_date: new Date(expires).toString(),
          sys_id: rec.expand.system.id,
          desc: covered,
          company: servicerName,
          phone: rec.expand.servicer.phone,
          expired: false,
          fac_id: rec.expand.system.facility,
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
  },
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

// -----------------------------------
// ✅ NEW ENDPOINT: POST /newsletter/test
// -----------------------------------
// Sends ONE test email to NEWS_LETTER_USER.
// ❌ Does NOT change newsletter_issues status
// ❌ Does NOT write newsletter_send_log
//
// Usage:
//  POST /newsletter/test
//   - optional: ?issueId=xxxx
//   - optional: ?slug=edition-02
//  Body (optional): { issueId, slug }
//
// Requires:
//  - NEWS_LETTER_USER in .env
//  - PB_MSTR_ADMIN_EMAIL / PB_MSTR_ADMIN_PASS in .env

async function getIssueForTest({ issueId, slug }) {
  await pbMstr
    .collection("_superusers")
    .authWithPassword(
      process.env.PB_MSTR_ADMIN_EMAIL,
      process.env.PB_MSTR_ADMIN_PASS,
    );

  const id = String(issueId || "").trim();
  const s = String(slug || "").trim();

  if (id) {
    return await pbMstr.collection("newsletter_issues").getOne(id);
  }

  if (s) {
    // Prefer exact slug match
    return await pbMstr
      .collection("newsletter_issues")
      .getFirstListItem(`slug="${s.replace(/"/g, '\\"')}"`);
  }

  // Default: most recent "not sent" issue
  // Adjust filter if you want ONLY drafts, etc.
  const list = await pbMstr.collection("newsletter_issues").getList(1, 1, {
    filter: `status != "sent"`,
    sort: "-created",
  });

  return list?.items?.[0] || null;
}

app.get("/newsletter/test", async (req, res) => {
  try {
    const testTo = String(process.env.NEWS_LETTER_USER || "").trim();
    if (!testTo) {
      return res.status(400).json({
        ok: false,
        error: "NEWS_LETTER_USER is not set in .env",
      });
    }

    const issueId = String(req.query.issueId || req.body?.issueId || "").trim();
    const slug = String(req.query.slug || req.body?.slug || "").trim();

    const issue = await getIssueForTest({ issueId, slug });
    if (!issue) {
      return res.status(404).json({
        ok: false,
        error: "No newsletter issue found for test send.",
      });
    }

    const subject = escapeText(issue.subject || "Predictaf Newsletter (Test)");
    const preheader = escapeText(issue.preheader || "");

    // if (!html && !text) {
    //   return res.status(400).json({
    //     ok: false,
    //     error: "Issue has no html or text content to send.",
    //     issue: { id: issue.id, slug: issue.slug, status: issue.status },
    //   });
    // }

    const html = String(issue.html || "").trim();
    const text = String(issue.text || "").trim();

    const looksLikeHtml = /<\s*(html|head|body|table|div|span|p|a)\b/i.test(
      text,
    );
    const finalHtml = html || (looksLikeHtml ? text : "");

    const htmlWithPreheader =
      preheader && finalHtml
        ? finalHtml.replace(
            /<body([^>]*)>/i,
            `<body$1><div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${preheader}</div>`,
          )
        : finalHtml;

    await transporter.sendMail({
      from: "support@predictiveaf.com",
      to: testTo,
      subject: `[TEST] ${subject}`,
      html: htmlWithPreheader || undefined,
      text: text && !looksLikeHtml ? text : undefined,
    });

    return res.status(200).json({
      ok: true,
      message: "Test newsletter email sent.",
      to: testTo,
      issue: {
        id: issue.id,
        slug: issue.slug || "",
        status: issue.status || "",
        subject,
      },
    });
  } catch (err) {
    console.error("POST /newsletter/test failed", err);
    return res.status(500).json({
      ok: false,
      error: "Internal error sending test newsletter.",
      details: err?.message || String(err),
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(
    `Server is running on port ${PORT} host is ${process.env.PB_HOST}`,
  );
});
