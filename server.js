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
pb.autoCancellation(false);
//Configure the email transporter - original, slow but works
// const transporter = nodemailer.createTransport({
//   host: "smtp-relay.brevo.com",
//   port: 587,
//   secure: false, // true for 465, false for other ports
//   auth: {
//     user: "lenflour@gmail.com", // your Brevo email
//     pass: "Xzn58PRpULQD02Bh", // your Brevo SMTP password
//   },
// });

//Configure the email transporter
// const transporter = nodemailer.createTransport({
//   host: "smtp-relay.brevo.com",
//   port: 587,
//   secure: false, // true for 465, false for other ports
//   auth: {
//     user: "7ed467001@smtp-brevo.com", // your Brevo email
//     pass: "yXCkpJGw0Dsb7fQx", // your Brevo SMTP password
//   },
// });

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
