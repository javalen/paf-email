const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const cors = require("cors");
const PocketBase = require("pocketbase/cjs");
require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(cors());
const pb = new PocketBase(process.env.PB_HOST);
const tuser = process.env.TRANSPORT_USER;
const tpass = process.env.TRANSPORT_PASS;
const path = require("path");
const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage() });

pb.autoCancellation(false);

/** Build a direct PocketBase file URL */
function pbFileUrl(base, collectionId, recordId, fileName) {
  if (!base) base = process.env.PB_HOST;
  return `${base.replace(
    /\/$/,
    ""
  )}/api/files/${collectionId}/${recordId}/${encodeURIComponent(fileName)}`;
}

/** Format date safely to mmm dd, yyyy */
function fmtD(d) {
  try {
    return new Date(d).toLocaleDateString();
  } catch {
    return "";
  }
}

/** Compact HTML “mini-console” for service company actions */
function serviceCompanyPage(rec) {
  const fac = rec.expand?.facility || {};
  const svc = rec.expand?.servicer || {};
  const sys = rec.expand?.system || {};
  const files = Array.isArray(rec.attachments)
    ? rec.attachments
    : rec.attachments
    ? [rec.attachments]
    : [];
  const fileLinks = files
    .map(
      (f) =>
        `<li><a href="${pbFileUrl(
          process.env.PB_HOST,
          rec.collectionId,
          rec.id,
          f
        )}" target="_blank" rel="noopener">${f}</a></li>`
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Service Request ${rec.svc_record_number || rec.id}</title>
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f6f7fb;margin:0;padding:0;color:#1f2937;}
  .wrap{max-width:880px;margin:24px auto;padding:16px;}
  .card{background:#fff;border:1px solid #e5e7eb;border-radius:12px;box-shadow:0 1px 2px rgba(0,0,0,.04);padding:18px;margin-bottom:14px;}
  h1{font-size:18px;margin:0 0 2px;}
  h2{font-size:16px;margin:0 0 10px;}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
  .muted{color:#6b7280}
  label{font-size:12px;color:#374151;display:block;margin:8px 0 6px}
  input,textarea{width:100%;padding:10px;border:1px solid #d1d5db;border-radius:8px;font:inherit}
  textarea{min-height:96px}
  .row{display:flex;gap:10px;align-items:center}
  .btn{appearance:none;border:0;background:#0f766e;color:#fff;padding:10px 14px;border-radius:10px;cursor:pointer}
  .btn.secondary{background:#1f2937}
  .btn:disabled{opacity:.6;cursor:not-allowed}
  .files{padding-left:18px}
  .hint{font-size:12px;color:#6b7280;margin-top:4px}
  .small{font-size:12px}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <h1>Service Request Details</h1>
        <div class="muted small">Created: ${fmtD(rec.created)}</div>
      </div>
      <div class="grid">
        <div>
          <h2>Facility</h2>
          <div><strong>${fac.name || "—"}</strong></div>
          <div class="muted small">${fac.address || ""}</div>
          <div class="muted small">${fac.city || ""}, ${fac.state || ""} ${
    fac.zipcode || ""
  }</div>
          <div class="muted small">${rec.fac_contact_number || ""}</div>
        </div>
        <div>
          <h2>Service Company</h2>
          <div><strong>${svc.name || "—"}</strong></div>
          <div class="muted small">${svc.address || ""}</div>
          <div class="muted small">${svc.city || ""}, ${svc.state || ""} ${
    svc.zip || ""
  }</div>
          <div class="muted small">${svc.phone || ""}</div>
        </div>
      </div>

      <div style="margin-top:12px">
        <h2>Description</h2>
        <div>${(rec.desc || "").replace(/\n/g, "<br/>")}</div>
      </div>

      <div class="grid" style="margin-top:14px">
        <div>
          <div class="muted small">Request #</div>
          <div><strong>${rec.svc_record_number || rec.id}</strong></div>
        </div>
        <div>
          <div class="muted small">System</div>
          <div><strong>${sys.name || rec.service_for || "—"}</strong></div>
        </div>
      </div>
    </div>

    <div class="card">
      <h2>Accept this Request</h2>
      <form class="grid" action="/service/${rec.id}/accept" method="POST">
        <div>
          <label>Your Name *</label>
          <input name="name" required placeholder="Your name"/>
        </div>
        <div>
          <label>Start Date *</label>
          <input type="date" name="start_date" required/>
        </div>
        <div>
          <button class="btn" type="submit">Accept</button>
        </div>
      </form>
      <div class="hint">Accepting sets the request to <em>accepted</em> and records your name & planned start date.</div>
    </div>

    <div class="card">
      <h2>Attach File</h2>
      <form action="/service/${
        rec.id
      }/upload" method="POST" enctype="multipart/form-data" class="row">
        <input type="file" name="file" required/>
        <input type="text" name="rename" placeholder="Rename (optional: e.g. estimate.pdf)"/>
        <button class="btn secondary" type="submit">Upload</button>
      </form>
      <div class="hint">Images/PDFs are attached to this request in PredictiveAF.</div>
      <div style="margin-top:10px">
        <div class="muted small">Files:</div>
        ${
          files.length
            ? `<ul class="files">${fileLinks}</ul>`
            : `<div class="small">No files attached.</div>`
        }
      </div>
    </div>

    <div class="card">
      <h2>Add a Comment</h2>
      <form action="/service/${rec.id}/comment" method="POST">
        <label>Comment *</label>
        <textarea name="comment" required></textarea>
        <div class="row" style="justify-content:flex-end;margin-top:8px">
          <button class="btn secondary" type="submit">Add Comment</button>
        </div>
      </form>
    </div>
  </div>
</body>
</html>`;
}

/** HTML email for the service company */
function serviceEmailTemplate(rec, pageUrl) {
  const fac = rec.expand?.facility || {};
  const svc = rec.expand?.servicer || {};
  const sys = rec.expand?.system || {};
  const files = Array.isArray(rec.attachments)
    ? rec.attachments
    : rec.attachments
    ? [rec.attachments]
    : [];

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
    : `<div style="color:#6b7280">No files attached.</div>`;

  return `
  <div style="font-family:Arial,Helvetica,sans-serif;color:#111;line-height:1.45">
    <h2 style="margin:0 0 8px">New Service Request</h2>
    <div style="font-size:13px;color:#555;margin-bottom:14px">Created: ${fmtD(
      rec.created
    )}</div>

    <table style="width:100%;border-collapse:collapse">
      <tr>
        <td style="vertical-align:top;padding:8px;border:1px solid #eee">
          <strong>Facility</strong><br/>
          ${fac.name || "—"}<br/>
          <span style="color:#666">${fac.address || ""}</span><br/>
          <span style="color:#666">${fac.city || ""}, ${fac.state || ""} ${
    fac.zipcode || ""
  }</span><br/>
          <span style="color:#666">${rec.fac_contact_number || ""}</span>
        </td>
        <td style="vertical-align:top;padding:8px;border:1px solid #eee">
          <strong>Service Company</strong><br/>
          ${svc.name || "—"}<br/>
          <span style="color:#666">${svc.address || ""}</span><br/>
          <span style="color:#666">${svc.city || ""}, ${svc.state || ""} ${
    svc.zip || ""
  }</span><br/>
          <span style="color:#666">${svc.phone || ""}</span>
        </td>
      </tr>
    </table>

    <p style="margin-top:14px"><strong>Description</strong><br/>${(
      rec.desc || ""
    ).replace(/\n/g, "<br/>")}</p>

    <table style="margin-top:8px">
      <tr><td style="padding:2px 8px 2px 0;color:#666">Request #</td><td><strong>${
        rec.svc_record_number || rec.id
      }</strong></td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#666">System</td><td><strong>${
        sys.name || rec.service_for || "—"
      }</strong></td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#666">Type</td><td>${
        rec.service_type || "—"
      }</td></tr>
      <tr><td style="padding:2px 8px 2px 0;color:#666">Status</td><td>${
        rec.status || "New"
      }</td></tr>
    </table>

    <div style="margin:16px 0">
      <a href="${pageUrl}"
         style="display:inline-block;background:#0f766e;color:#fff;text-decoration:none;padding:10px 16px;border-radius:8px">
         Open Request
      </a>
    </div>

    <div style="margin-top:12px">
      <strong>Files</strong>
      ${filesHtml}
    </div>

    <div style="margin-top:18px;font-size:12px;color:#6b7280">
      You can accept the request, upload files, and add comments from the page above.
    </div>
  </div>`;
}

const transporter = nodemailer.createTransport({
  host: "s1099.usc1.mysecurecloudhost.com",
  port: 465,
  secure: true, // true for 465, false for other ports
  auth: {
    user: tuser,
    pass: tpass,
  },
});

function validateAndFormatPhoneNumber(phone) {
  // Remove all non-digit characters
  const digits = phone.replace(/\D/g, "");

  // Check if there are exactly 10 digits
  if (digits.length !== 10) {
    return null; // Invalid number
  }

  // Format to (123) 456-7890
  const area = digits.slice(0, 3);
  const mid = digits.slice(3, 6);
  const last = digits.slice(6, 10);

  return `(${area}) ${mid}-${last}`;
}

// Email template
const welcomeEmailTemplate = (client, name, verificationLink) => `
<html><head></head><body><div style="border: 3px solid;">
    <div style="padding: 25px;font: 15px Arial, sans-serif;">
        <hr>
        <p style="text-align: center;"><strong>Welcome to PredictiveAF, ${client}!</strong></p>
        <hr>
        <p>Hi ${name},</p>
        <p>Welcome aboard!</p>
        <p>We're thrilled to have you as part of the PredictiveAF community. Your journey into the world of predictive analytics starts now, and we’re here to help you every step of the way.</p>
        
        <h3>Verify Your Email</h3>
        <p>To ensure the security of your account, please verify your email by clicking the button below:</p>
        <a href="${verificationLink}" style="display: inline-block; padding: 10px 20px; font-size: 16px; color: #fff; background-color: #007bff; text-decoration: none; border-radius: 5px;">Verify Email</a>
        <p>Thank you for choosing PredictiveAF. We look forward to seeing you unlock the full potential of predictive analytics.</p>
        <p>Best regards,</p>
        <p>The PredictiveAF Team</p>
        <hr>
        <p><strong>Follow us on social media:</strong></p>
        <ul>
            <li><a rel="noreferrer" href="${process.env.PAF_FB_PAGE}">Facebook</a></li>
            
        </ul>
        <p><strong>Contact Us:</strong> PredictiveAF Inc. <a rel="noreferrer">support@predictiveaf.com</a></p>
        <hr>
    </div>
</div></body></html>
`;

const tenantTicketTemplate = (
  manager,
  tenant,
  unit,
  ticketNum,
  issue,
  phone
) => `
<html>
  <head>
    <style>
      body {
        font-family: Arial, sans-serif;
        font-size: 15px;
        color: #333;
      }
      .container {
        border: 3px solid #ccc;
        padding: 25px;
        max-width: 600px;
        margin: auto;
      }
      .footer {
        font-size: 13px;
        color: #777;
        border-top: 1px solid #ccc;
        padding-top: 15px;
        margin-top: 30px;
      }
      .social a {
        color: #2a7ae2;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <p>Dear ${manager},</p>

      <p>
        A new maintenance ticket has been submitted by ${tenant} in unit ${unit}.
        The ticket number is <strong>${ticketNum}</strong>.
      </p>

      <h3 style="margin-top: 30px;">Issue Description</h3>
      <blockquote style="margin: 15px 0; font-style: italic; color: #555;">
        ${issue}
      </blockquote>

      <p>
        You can contact the tenant directly at 
        <strong>${validateAndFormatPhoneNumber(phone)}</strong>.
      </p>

      <p>
        Please log in to your dashboard to review and take action on this ticket.
      </p>

      <p>Thank you for using PredictiveAF.</p>
      <p>Best regards,</p>
      <p><strong>The PredictiveAF Team</strong></p>

      <div class="footer">
        <p><strong>Follow us on social media:</strong></p>
        <ul class="social">
          <li><a href="${
            process.env.PAF_FB_PAGE
          }" target="_blank" rel="noreferrer">Facebook</a></li>
        </ul>
        <p><strong>Contact Us:</strong> PredictiveAF Inc. – <a href="mailto:support@predictiveaf.com">support@predictiveaf.com</a></p>
      </div>
    </div>
  </body>
</html>

`;

const tenantUpdateTicketTemplate = (
  tenant,
  unit,
  ticketNum,
  issue,
  phone,
  ticketLink,
  facility
) => `
<html>
  <head>
    <style>
      body {
        font-family: Arial, sans-serif;
        font-size: 15px;
        color: #333;
      }
      .container {
        border: 3px solid #ccc;
        padding: 25px;
        max-width: 600px;
        margin: auto;
      }
      .footer {
        font-size: 13px;
        color: #777;
        border-top: 1px solid #ccc;
        padding-top: 15px;
        margin-top: 30px;
      }
      .social a {
        color: #2a7ae2;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <p>Dear ${tenant},</p>

      <p>
        Management has been notified of a new maintenance ticket you submitted for unit ${unit}.
        The ticket number is <strong>${ticketNum}</strong>.
      </p>

      <h3 style="margin-top: 30px;">Issue Description</h3>
      <blockquote style="margin: 15px 0; font-style: italic; color: #555;">
        ${issue}
      </blockquote>

      <p>
        You may be contacted by management at 
        <strong>${validateAndFormatPhoneNumber(phone)}</strong>.
      </p>

      <p>
        You can always monitor the status of your ticket at <a href="${
          process.env.PAF_PANEL_HOST
        }/tenants">Ticket Console</a>
      </p>

      <p>
        Please do not reply to this email. If you have any questions contact ${facility} management.
      </p>
      
      <p>Thank you for using PredictiveAF.</p>
      <p>Best regards,</p>
      <p><strong>The PredictiveAF Team</strong></p>

      <div class="footer">
        <p><strong>Follow us on social media:</strong></p>
        <ul class="social">
          <li><a href="${
            process.env.PAF_FB_PAGE
          }" target="_blank" rel="noreferrer">Facebook</a></li>
        </ul>
        <p><strong>Contact Us:</strong> PredictiveAF Inc. – <a href="mailto:support@predictiveaf.com">support@predictiveaf.com</a></p>
      </div>
    </div>
  </body>
</html>

`;

const ticketCommentTemplate = (
  tenant,
  unit,
  ticketNum,
  comment,
  phone,
  ticketLink,
  facility
) => `
<html>
  <head>
    <style>
      body {
        font-family: Arial, sans-serif;
        font-size: 15px;
        color: #333;
      }
      .container {
        border: 3px solid #ccc;
        padding: 25px;
        max-width: 600px;
        margin: auto;
      }
      .footer {
        font-size: 13px;
        color: #777;
        border-top: 1px solid #ccc;
        padding-top: 15px;
        margin-top: 30px;
      }
      .social a {
        color: #2a7ae2;
        text-decoration: none;
      }
    </style>
  </head>
  <body>
    <div class="container">
      <p>Dear ${tenant},</p>

      <p>
        A comment has been added to a tiket for unit ${unit}.
        The ticket number is <strong>${ticketNum}</strong>.
      </p>

      <h3 style="margin-top: 30px;">Comment:</h3>
      <blockquote style="margin: 15px 0; font-style: italic; color: #555;">
        ${comment}
      </blockquote>

      <p>
        You may be contacted by management at 
        <strong>${validateAndFormatPhoneNumber(phone)}</strong>.
      </p>

      <p>
        You can always monitor the status of your ticket at <a href="${
          process.env.PAF_PANEL_HOST
        }/tenants">Ticket Console</a>
      </p>

      <p>
        Please do not reply to this email. If you have any questions contact ${facility} management.
      </p>
      
      <p>Thank you for using PredictiveAF.</p>
      <p>Best regards,</p>
      <p><strong>The PredictiveAF Team</strong></p>

      <div class="footer">
        <p><strong>Follow us on social media:</strong></p>
        <ul class="social">
          <li><a href="${
            process.env.PAF_FB_PAGE
          }" target="_blank" rel="noreferrer">Facebook</a></li>
        </ul>
        <p><strong>Contact Us:</strong> PredictiveAF Inc. – <a href="mailto:support@predictiveaf.com">support@predictiveaf.com</a></p>
      </div>
    </div>
  </body>
</html>
`;

const clientVerificationSuccess = (name, client) => {
  return `<div style="padding: 25px; font-family: Arial, sans-serif; font-size: 15px; color: #333; max-width: 900px; margin: 0 auto; line-height: 1.6;">
  <h3 style="font-size: 18px; margin-top: 30px; margin-bottom: 30px; color: #222; text-align: center;">
  Welcome to PredictiveAF!
</h3>
  <p>Hi ${name},</p>

  <p>
    Thank you for creating your account and verifying your email with <strong>PredictiveAF</strong>!
  </p>

  <p>
    We’re delighted to officially welcome you to our community. By verifying your email, you’ve unlocked the full potential of our predictive analytics platform. Get ready to transform your data into actionable insights and make smarter decisions.
  </p>

  <h3 style="font-size: 18px; margin-top: 30px; color: #222;">What’s Next?</h3>

  <ol style="padding-left: 20px; margin-top: 10px;">
    <li style="margin-bottom: 10px;">
      <strong>Access the PAF Control Panel:</strong>
      Use your application login to access the control panel
      <a href="${process.env.PAF_PANEL_HOST}" style="color: #1a73e8; text-decoration: none;">here</a>. <strong>Be sure to bookmark it for future reference!</strong>
    </li>
    <li style="margin-bottom: 10px;">
      <strong>Explore Our Features:</strong> Dive into our suite of tools and discover how PredictiveAF can help you predict trends and optimize outcomes.
    </li>
    <li style="margin-bottom: 10px;">
      <strong>Personalize Your Experience:</strong> Adjust your settings to receive the most relevant data and predictions tailored to your needs.
    </li>
    <li style="margin-bottom: 10px;">
      <strong>Join the Community:</strong> Connect with other users, share insights, and learn from experts in our community forum.
    </li>
  </ol>

  <h3 style="font-size: 18px; margin-top: 30px; color: #222;">Get Started</h3>

  <p>To help you get started, we’ve prepared some resources:</p>

  <ul style="padding-left: 20px;">
    <li style="margin-bottom: 8px;">
      <a href="https://predictiveaf.com/quickstart" style="color: #1a73e8; text-decoration: none;"><strong>Quick Start Guide</strong></a>
    </li>
    <li style="margin-bottom: 8px;">
      <a href="https://www.youtube.com/@PredictiveAF" style="color: #1a73e8; text-decoration: none;"><strong>Video Tutorials</strong></a>
    </li>
    <li style="margin-bottom: 8px;">
      <a href="https://predictiveaf.com/support" style="color: #1a73e8; text-decoration: none;"><strong>Support Center</strong></a>
    </li>
  </ul>

  <p>
    If you have any questions or need assistance, our support team is here for you. Feel free to reach out to us anytime at
    <a href="mailto:support@predictiveaf.com" style="color: #1a73e8; text-decoration: none;">support@predictiveaf.com</a>.
  </p>

  <p>Thank you once again for choosing PredictiveAF. We’re excited to see how you’ll leverage our tools to drive success.</p>

  <p>Best regards,</p>
  <p><strong>The PredictiveAF Team</strong></p>

  <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;" />

  <p><strong>Follow us on social media:</strong></p>
  <ul style="padding-left: 20px;">
    <li>
      <a href="${process.env.PAF_FB_PAGE}" style="color: #1a73e8; text-decoration: none;">Facebook</a>
    </li>
    <!-- Uncomment and update as needed:
    <li><a href="#" style="color: #1a73e8;">Twitter</a></li>
    <li><a href="#" style="color: #1a73e8;">LinkedIn</a></li>
    -->
  </ul>

  <p><strong>Contact Us:</strong> PredictiveAF Inc. — <a href="mailto:support@predictiveaf.com" style="color: #1a73e8; text-decoration: none;">support@predictiveaf.com</a></p>

  <hr style="margin: 30px 0; border: none; border-top: 1px solid #ddd;" />
</div>
`;
};

const changePassword = (name) => {
  `<!DOCTYPE html>
  <html lang="en">
  <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Change Password</title>
      <style>
          body {
              font-family: Arial, sans-serif;
              margin: 0;
              padding: 0;
              display: flex;
              justify-content: center;
              align-items: center;
              height: 100vh;
              background-color: #f0f0f0;
          }
          .form-container {
              background-color: white;
              padding: 20px;
              border-radius: 8px;
              box-shadow: 0 0 10px rgba(0, 0, 0, 0.1);
          }
          .form-container h2 {
              margin-bottom: 20px;
          }
          .form-container label {
              display: block;
              margin-bottom: 8px;
          }
          .form-container input[type="password"],
          .form-container input[type="submit"] {
              width: 100%;
              padding: 10px;
              margin-bottom: 15px;
              border: 1px solid #ccc;
              border-radius: 4px;
          }
          .form-container input[type="submit"] {
              background-color: #007BFF;
              color: white;
              cursor: pointer;
              transition: background-color 0.3s;
          }
          .form-container input[type="submit"]:hover {
              background-color: #0056b3;
          }
      </style>
  </head>
  <body>
      <div class="form-container">
          <h2>Change Password</h2>
          <form action="${process.env.PAF_MAIL_HOST}/changepw" method="POST">
              <label for="current-password">Current Password:</label>
              <input type="password" id="current-password" name="current_password" required>
              
              <label for="new-password">New Password:</label>
              <input type="password" id="new-password" name="new_password" required>
              
              <label for="confirm-password">Confirm New Password:</label>
              <input type="password" id="confirm-password" name="confirm_password" required>
              
              <input type="submit" value="Change Password">
          </form>
      </div>
  </body>
  </html>
  `;
};

const verificationAcceptRole = (name, facility) => {
  return `<div class="flex flex-col w-full gap-4 p-6 bg-white dark:bg-gray-800 rounded-lg shadow-md">
  <div class="markdown prose dark:prose-invert w-full break-words">
    <p class="text-2xl font-bold text-gray-800 dark:text-gray-200">Subject: Thank You for Verifying Your Email ${name}</p>
    <hr class="my-4 border-t border-gray-200 dark:border-gray-600" />
    <p class="text-lg">Hi ${name},</p>
    <p>Thank you for accepting the role in ${facility}. You have successfully registered your account with PredictiveAF!</p>
    <p>
      We’re delighted to officially welcome you to our community. By verifying your email, you’ve unlocked the full potential of our predictive analytics platform. Get ready to transform your data into actionable insights and make
      smarter decisions.
    </p>
    <h3 class="text-xl font-semibold mt-6">What’s Next?</h3>
    <ol class="list-decimal list-inside pl-4 mt-2 space-y-2">
      <li><strong>Explore Our Features:</strong> Dive into our suite of tools and discover how PredictiveAF can help you predict trends and optimize outcomes.</li>
      <li><strong>Personalize Your Experience:</strong> Adjust your settings to receive the most relevant data and predictions tailored to your needs.</li>
      <li><strong>Join the Community:</strong> Connect with other users, share insights, and learn from experts in our community forum.</li>
    </ol>
    <h3 class="text-xl font-semibold mt-6">Get Started</h3>
    <p>To help you get started, we’ve prepared some resources:</p>
    <ul class="list-disc list-inside pl-4 mt-2 space-y-2">
      <li><strong>Quick Start Guide:</strong> [Link to guide]</li>
      <li><strong>Video Tutorials:</strong> [Link to tutorials]</li>
      <li><strong>Support Center:</strong> [Link to support]</li>
    </ul>
    <p>If you have any questions or need assistance, our support team is here for you. Feel free to reach out to us anytime at <a href="mailto:support@predictiveaf.com" class="text-blue-600 dark:text-blue-400">support@predictiveaf.com</a>.</p>
    <p>Thank you once again for choosing PredictiveAF. We’re excited to see how you’ll leverage our tools to drive success.</p>
    <p>Best regards,</p>
    <p>The PredictiveAF Team</p>
    <hr class="my-4 border-t border-gray-200 dark:border-gray-600" />
    <p><strong>Follow us on social media:</strong></p>
    <ul class="flex space-x-4">
      <li><a href="${process.env.PAF_FB_PAGE}" class="text-blue-600 dark:text-blue-400">Facebook</a></li>
      <li><a href="#" class="text-blue-600 dark:text-blue-400">LinkedIn</a></li>
    </ul>
    <p class="mt-4"><strong>Contact Us:</strong> PredictiveAF Inc. [Address Line 1] [Address Line 2] <a href="mailto:support@predictiveaf.com" class="text-blue-600 dark:text-blue-400">support@predictiveaf.com</a></p>
    <hr class="my-4 border-t border-gray-200 dark:border-gray-600" />
  </div>
</div>
  `;
};

const addUserToFacility = (
  name,
  client,
  role,
  addedBy,
  facility,
  verificationLink
) => {
  return `<div class="flex w-full flex-col gap-1 juice:empty:hidden juice:first:pt-[3px]">
      <div class="markdown prose w-full break-words dark:prose-invert light">
          <p><strong>Subject: You've been added as a ${role} to ${facility} by ${addedBy} from ${client}</strong></p>
          <hr />
          <p>Hi ${name},</p>
          <p>You've been added as a ${role} to ${facility} by ${addedBy} from ${client}</p>
          <p>We're thrilled to have you as part of the PredictiveAF community. Your journey into the world of predictive analytics starts now, and we’re here to help you every step of the way.</p>
          <p>If you have any questions or need assistance, our support team is just an email away at [<a rel="noreferrer">support@predictiveaf.com</a>].</p>
          <h3>What’s Next?</h3>
          
          <h3>Verify Your Email</h3>
          <p>To ensure the security of your account, please verify your email by clicking the button below:</p>
          <a href="${verificationLink}" style="display: inline-block; padding: 10px 20px; font-size: 16px; color: #fff; background-color: #007bff; text-decoration: none; border-radius: 5px;">Verify Email</a>
          <p>Thank you for choosing PredictiveAF. We look forward to seeing you unlock the full potential of predictive analytics.</p>
          <p>Best regards,</p>
          <p>The PredictiveAF Team</p>
          <hr />
          <p><strong>Follow us on social media:</strong></p>
          <ul>
              <li><a rel="noreferrer" href="${process.env.PAF_FB_PAGE}">Facebook</a></li>
              <li><a rel="noreferrer" href="#">Twitter</a></li>
              <li><a rel="noreferrer" href="#">LinkedIn</a></li>
          </ul>
          <p><strong>Contact Us:</strong> PredictiveAF Inc. [Address Line 1] [Address Line 2] [<a rel="noreferrer">support@predictiveaf.com</a>]</p>
          <hr />
      </div>
  </div>
  `;
};

const addAdminToClient = (client, name, addedBy, verificationLink) => {
  return `<div class="flex w-full flex-col gap-1 juice:empty:hidden juice:first:pt-[3px]">
      <div class="markdown prose w-full break-words dark:prose-invert light">
          <p><strong>Subject: You've been added as a Administrator to a PAF Client.</strong></p>
          <hr />
          <p>Hi ${name},</p>
          <p>You've been added as a Client Rep to ${client} by ${addedBy}.</p>
          <p>We're thrilled to have you as part of the PredictiveAF community. Your journey into the world of predictive analytics starts now, and we’re here to help you every step of the way.</p>
          <p>If you have any questions or need assistance, our support team is just an email away at [<a rel="noreferrer">support@predictiveaf.com</a>].</p>
          <h3>What’s Next?</h3>
          
          <h3>Verify Your Email</h3>
          <p>To ensure the security of your account, please verify your email by clicking the button below:</p>
          <a href="${verificationLink}" style="display: inline-block; padding: 10px 20px; font-size: 16px; color: #fff; background-color: #007bff; text-decoration: none; border-radius: 5px;">Verify Email</a>
          <p>Thank you for choosing PredictiveAF. We look forward to seeing you unlock the full potential of predictive analytics.</p>
          <p>Best regards,</p>
          <p>The PredictiveAF Team</p>
          <hr />
          <p><strong>Follow us on social media:</strong></p>
          <ul>
              <li><a rel="noreferrer" href="${process.env.PAF_FB_PAGE}">Facebook</a></li>
              <li><a rel="noreferrer" href="#">Twitter</a></li>
              <li><a rel="noreferrer" href="#">LinkedIn</a></li>
          </ul>
          <p><strong>Contact Us:</strong> PredictiveAF Inc. [Address Line 1] [Address Line 2] [<a rel="noreferrer">support@predictiveaf.com</a>]</p>
          <hr />
      </div>
  </div>
  `;
};

const adminVerificationSuccess = (name) => {
  return `<div class="flex w-full flex-col gap-1 juice:empty:hidden juice:first:pt-[3px]">
    <div class="markdown prose w-full break-words dark:prose-invert light">
        <p><strong>Subject: Thank You for Verifying Your Email.</strong></p>
        <hr />
        <p>Hi ${name},</p>
        <p>Thank you for accepting your Admin role and verifying your email with PredictiveAF!</p>
        <p>
            We’re delighted to officially welcome you to our community. By verifying your email, you’ve unlocked the full potential of our predictive analytics platform. Get ready to transform your data into actionable insights and make
            smarter decisions.
        </p>
        <h3>What’s Next?</h3>
        <ol>
            <li><strong>Explore Our Features:</strong> Dive into our suite of tools and discover how PredictiveAF can help you predict trends and optimize outcomes.</li>
            <li><strong>Personalize Your Experience:</strong> Adjust your settings to receive the most relevant data and predictions tailored to your needs.</li>
            <li><strong>Join the Community:</strong> Connect with other users, share insights, and learn from experts in our community forum.</li>
        </ol>
        <h3>Get Started</h3>
        <p>To help you get started, we’ve prepared some resources:</p>
        <ul>
            <li><strong>Quick Start Guide:</strong> [Link to guide]</li>
            <li><strong>Video Tutorials:</strong> [Link to tutorials]</li>
            <li><strong>Support Center:</strong> [Link to support]</li>
        </ul>
        <p>If you have any questions or need assistance, our support team is here for you. Feel free to reach out to us anytime at [<a rel="noreferrer">support@predictiveaf.com</a>].</p>
        <p>Thank you once again for choosing PredictiveAF. We’re excited to see how you’ll leverage our tools to drive success.</p>
        <p>Best regards,</p>
        <p>The PredictiveAF Team</p>
        <hr />
        <p><strong>Follow us on social media:</strong></p>
        <ul>
            <li><a rel="noreferrer" href="${process.env.PAF_FB_PAGE}">Facebook</a></li>
            <li><a rel="noreferrer" href="#">Twitter</a></li>
            <li><a rel="noreferrer" href="#">LinkedIn</a></li>
        </ul>
        <p><strong>Contact Us:</strong> PredictiveAF Inc. [Address Line 1] [Address Line 2] [<a rel="noreferrer">support@predictiveaf.com</a>]</p>
        <hr />
    </div>
</div>
`;
};

const sendAdminVerificaitonSuccessEmail = (to, name) => {
  console.log("sendVerificaitonSuccessEmail");
  axios
    .post(`${process.env.PAF_MAIL_HOST}/send-admin-verify-success`, {
      to: to,
      name: name,
    })
    .then((response) => {
      //alert("Email sent successfully");
      console.error("Email sent successfully");
    })
    .catch((error) => {
      //alert("Error sending email");
      console.error("Error sending email", error);
    });
};

// This is called once the admin accepts the role
app.get("/admin", async function (req, res) {
  const { token } = req.query;
  console.log("Token " + token);
  const { user } = await verifyAdminUser(token);
  sendAdminVerificaitonSuccessEmail(token, user.name);

  res.status(200).send(adminVerificationSuccess(user.name));
});

app.post("/send-admin-email", async function (req, res) {
  const { client, to, subject, addedBy, name } = req.body;
  const verificationLink = `${process.env.PAF_MAIL_HOST}/admin?token=${to}`;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: addAdminToClient(client, name, addedBy, verificationLink),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    res.status(200).send("Email sent: " + info.response);
  });
});

app.post("/send-admin-verify-success", (req, res) => {
  const { to, name } = req.body;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: "PAF Verification Success! ",
    html: adminVerificationSuccess(name),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    res.status(200).send("Email sent: " + info.response);
  });
});

const verifyAdminUser = async (email) => {
  console.log("verifyAdminUser ", email);
  try {
    const user = await pb
      .collection("users")
      .getFirstListItem(`email="${email}"`);

    console.log("User", user.name);
    //TODO: This could be an issue if the user is already in the personel table
    const personel = await pb
      .collection("personel")
      .getFirstListItem(`user="${user.id}" && role="cr"`);
    console.log("Personel", personel.full_name);
    const record = await pb
      .collection("personel")
      .update(personel.id, { verified: true });
    console.log("Personel verified", record);
    return { user: user };
  } catch (error) {
    console.log(`Error verifying User ${error}`);
  }
};

app.get("/accept-role", async function (req, res) {
  const { token } = req.query;
  console.log("Token " + token);
  const { name, facility } = await acceptRoleInFacility(token);

  res.status(200).send(verificationAcceptRole(name, facility));
});

// This is called when a new client is created, the host is the pb host for a region
app.post("/send-welcome-email", (req, res) => {
  const { client, to, subject, name, host } = req.body;
  const verificationLink = `${process.env.PAF_MAIL_HOST}/verify-email?token=${to}&host=${host}`;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: welcomeEmailTemplate(client, name, verificationLink),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log("Error sending welcome email to", to, client, error);
      return res.status(500).send(error.toString());
    }
    console.log("Successful sending welcome email to", to, client);
    res.status(200).send("Email sent: " + info.response);
  });
});

app.post("/tenant-ticket-email", (req, res) => {
  const { to, subject, tenant, manager, unit, issue, ticket_num, phone } =
    req.body;

  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: tenantTicketTemplate(manager, tenant, unit, ticket_num, issue, phone),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log("Error sending tenant ticket email to", to, error);
      return res.status(500).send(error.toString());
    }
    console.log("Successful sending tenant ticket email email to", to);
    res.status(200).send("Email sent: " + info.response);
  });
});

// This is sent when a tenant submits a maintenance ticket
app.post("/tenant-update-email", (req, res) => {
  const {
    to,
    subject,
    tenant,
    unit,
    ticketNum,
    issue,
    phone,
    ticketLink,
    facility,
  } = req.body;

  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: tenantUpdateTicketTemplate(
      tenant,
      unit,
      ticketNum,
      issue,
      phone,
      ticketLink,
      facility
    ),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log("Error sending tenant ticket email to", to, error);
      return res.status(500).send(error.toString());
    }
    console.log("Successful sending tenant ticket email email to", to);
    res.status(200).send("Email sent: " + info.response);
  });
});

// This is sent when a tenant submits a maintenance ticket
app.post("/ticket-comment-email", (req, res) => {
  const {
    to,
    subject,
    tenant,
    unit,
    ticketNum,
    comment,
    phone,
    ticketLink,
    facility,
  } = req.body;

  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: ticketCommentTemplate(
      tenant,
      unit,
      ticketNum,
      comment,
      phone,
      ticketLink,
      facility
    ),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      console.log("Error sending tenant ticket email to", to, error);
      return res.status(500).send(error.toString());
    }
    console.log("Successful sending tenant ticket email email to", to);
    res.status(200).send("Email sent: " + info.response);
  });
});

// This is called once the user has verified the new client
app.get("/verify-email", async function (req, res) {
  const { token, host } = req.query;
  console.log("Token " + token);
  const { client, user } = await verifyUserAndClient(token, host);

  sendVerificaitonSuccessEmail(token, user.name, client.name);

  res.status(200).send(clientVerificationSuccess(user.name, client.name));
});

const acceptRoleInFacility = async (id) => {
  try {
    const record = await pb.collection("new_users").getOne(id, {
      expand: "personel,facility",
    });

    const newUser = await pb
      .collection("new_users")
      .update(record.id, { verified: true });
    const personel = await pb
      .collection("personel")
      .update(record.expand.personel.id, { verified: true });

    return { name: personel.full_name, facility: record.expand.facility.name };
  } catch (error) {
    console.log(`Error accepting role ${error}`);
  }
};

app.post("/send-verify-success", (req, res) => {
  const { client, to, name } = req.body;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: "PAF Verification Success! ",
    html: clientVerificationSuccess(name, client),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    res.status(200).send("Email sent: " + info.response);
  });
});

// Called when a new user is added to a facility
app.post("/send-new-user-email", (req, res) => {
  const { to, facility, name, client, role, addedBy, newUserId } = req.body;
  const verificationLink = `${process.env.PAF_PANEL_HOST}/cpw/${newUserId}`;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: "Welcome to PredictiveAF!",
    html: addUserToFacility(
      name,
      client,
      role,
      addedBy,
      facility,
      verificationLink
    ),
  };
  console.log(`Sending new user email to ${to}`);

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    console.log(`new user email to ${to} successful`);
    res.status(200).send("Email sent: " + info.response);
  });
});

app.post("/send-new-admin-email", (req, res) => {
  const { client, to, name, addedBy, newUserId } = req.body;
  const verificationLink = `${process.env.PAF_PANEL_HOST}/cpw/${newUserId}`;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: "Welcome to PredictiveAF!",
    html: addAdminToClient(client, name, addedBy, verificationLink),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    res.status(200).send("Email sent: " + info.response);
  });
});

/**
 * POST /email-service-co
 * Body: { record: <service_history with expand>, to?: string }
 * If expand is missing, the endpoint will fetch it.
 */
app.post("/email-service-co", async (req, res) => {
  try {
    const payload = req.body?.record || req.body;
    console.log("Record", payload);
    if (!payload || !payload.id) {
      return res
        .status(400)
        .send("Missing service_history record (id required).");
    }

    // Ensure the record is fresh and expanded
    const rec = payload.expand
      ? payload
      : await pb.collection("service_history").getOne(payload.id, {
          expand: "facility,servicer,system",
        });

    // figure out recipient
    const to =
      req.body?.to ||
      rec.expand?.servicer?.email ||
      process.env.FALLBACK_SERVICE_EMAIL; // optional fallback
    console.log("Sending email to:", rec.expand?.servicer?.email);
    if (!to)
      return res.status(400).send("No destination email for service company.");

    // public page URL for actions
    const pageUrl = `${process.env.PAF_MAIL_HOST.replace(/\/$/, "")}/service/${
      rec.id
    }`;

    const mailOptions = {
      from: "support@predictiveaf.com",
      to,
      subject: `Service Request ${rec.svc_record_number || rec.id} — ${
        rec.expand?.facility?.name || ""
      }`,
      html: serviceEmailTemplate(rec, pageUrl),
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.error("Error sending service company email:", error);
        return res.status(500).send(error.toString());
      }
      res.status(200).send("Email sent: " + info.response);
    });
  } catch (err) {
    console.error("email-service-co failed", err);
    res.status(500).send("Internal error sending email.");
  }
});

// Show interactive page (accept, upload, comment)
app.get("/service/:id", async (req, res) => {
  try {
    const rec = await pb.collection("service_history").getOne(req.params.id, {
      expand: "facility,servicer,system",
    });
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(200).send(serviceCompanyPage(rec));
  } catch (e) {
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
    // optional rename
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
      const user = "Service Company"; // or derive from a token in query if you add auth
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

const sendVerificaitonSuccessEmail = (to, name, client) => {
  console.log("sendVerificaitonSuccessEmail");
  axios
    .post(`${process.env.PAF_MAIL_HOST}/send-verify-success`, {
      to: to,
      name: name,
      client: client,
    })
    .then((response) => {
      //alert("Email sent successfully");
      console.error("Email sent successfully");
    })
    .catch((error) => {
      //alert("Error sending email");
      console.error("Error sending email", error);
    });
};

const verifyClient = async (id, backend) => {
  try {
    console.log("Updating client");
    const client = await backend
      .collection("client")
      .getFirstListItem(`manager="${id}"`);

    const record = await backend
      .collection("client")
      .update(client.id, { verified: true });
    console.log("Client verified:", record.verified);

    return record;
  } catch (error) {
    console.log(`Error verifying Client ${error}`);
  }
};

const verifyUserAndClient = async (email, host) => {
  console.log("verifyUserAndClient ", email, "host", host);
  try {
    const clientpb = new PocketBase(host);
    const user = await clientpb
      .collection("users")
      .getFirstListItem(`email="${email}"`);

    const personel = await clientpb
      .collection("personel")
      .getFirstListItem(`user="${user.id}"`);
    const record = await clientpb
      .collection("personel")
      .update(personel.id, { verified: true });
    console.log("Personel verified", record);
    const client = await verifyClient(user.id, clientpb);
    return { client: client, user: user };
  } catch (error) {
    console.log(`Error verifying User ${error}`);
  }
  clientpb = null;
};

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(
    `Server is running on port ${PORT} host is ${process.env.PB_HOST}`
  );
});
