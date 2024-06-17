const express = require("express");
const axios = require("axios");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const cors = require("cors");
const PocketBase = require("pocketbase/cjs");

const app = express();
app.use(bodyParser.json());
app.use(cors());
const pb = new PocketBase("https://predictiveaf-dev.fly.dev/");
// Configure the email transporter
const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false, // true for 465, false for other ports
  auth: {
    user: "lenflour@gmail.com", // your Brevo email
    pass: "Xzn58PRpULQD02Bh", // your Brevo SMTP password
  },
});

// Email template
const welcomeEmailTemplate = (client, name, verificationLink) => `
<div class="flex w-full flex-col gap-1 juice:empty:hidden juice:first:pt-[3px]">
    <div class="markdown prose w-full break-words dark:prose-invert light">
        <hr />
        <p><strong>Subject: Welcome to PredictiveAF, ${client}!</strong></p>
        <hr />
        <p>Hi ${name},</p>
        <p>Welcome aboard!</p>
        <p>We're thrilled to have you as part of the PredictiveAF community. Your journey into the world of predictive analytics starts now, and we’re here to help you every step of the way.</p>
        <h3>What’s Next?</h3>
        <ol>
            <li><strong>Explore Our Features:</strong> Dive into the app and discover powerful tools designed to give you accurate and actionable insights.</li>
            <li><strong>Personalize Your Experience:</strong> Customize your preferences to get the most relevant data and predictions tailored to your needs.</li>
            <li><strong>Join the Community:</strong> Connect with other users, share your insights, and learn from experts in our community forum.</li>
        </ol>
        <h3>Get Started</h3>
        <p>To help you get started, we’ve prepared some resources:</p>
        <ul>
            <li><strong>Quick Start Guide:</strong> [Link to guide]</li>
            <li><strong>Video Tutorials:</strong> [Link to tutorials]</li>
            <li><strong>Support Center:</strong> [Link to support]</li>
        </ul>
        <p>If you have any questions or need assistance, our support team is just an email away at [<a rel="noreferrer">support@predictiveaf.com</a>].</p>
        <h3>Verify Your Email</h3>
        <p>To ensure the security of your account, please verify your email by clicking the button below:</p>
        <a href="${verificationLink}" style="display: inline-block; padding: 10px 20px; font-size: 16px; color: #fff; background-color: #007bff; text-decoration: none; border-radius: 5px;">Verify Email</a>
        <p>Thank you for choosing PredictiveAF. We look forward to seeing you unlock the full potential of predictive analytics.</p>
        <p>Best regards,</p>
        <p>The PredictiveAF Team</p>
        <hr />
        <p><strong>Follow us on social media:</strong></p>
        <ul>
            <li><a rel="noreferrer" href="#">Facebook</a></li>
            <li><a rel="noreferrer" href="#">Twitter</a></li>
            <li><a rel="noreferrer" href="#">LinkedIn</a></li>
        </ul>
        <p><strong>Contact Us:</strong> PredictiveAF Inc. [Address Line 1] [Address Line 2] [<a rel="noreferrer">support@predictiveaf.com</a>]</p>
        <hr />
    </div>
</div>
`;

const verificationSuccess = (name, client) => {
  return `<div class="flex w-full flex-col gap-1 juice:empty:hidden juice:first:pt-[3px]">
    <div class="markdown prose w-full break-words dark:prose-invert light">
        <p><strong>Subject: Thank You for Verifying Your Email for ${client}</strong></p>
        <hr />
        <p>Hi ${name},</p>
        <p>Thank you for creating your account and verifying your email with PredictiveAF!</p>
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
            <li><a rel="noreferrer" href="#">Facebook</a></li>
            <li><a rel="noreferrer" href="#">Twitter</a></li>
            <li><a rel="noreferrer" href="#">LinkedIn</a></li>
        </ul>
        <p><strong>Contact Us:</strong> PredictiveAF Inc. [Address Line 1] [Address Line 2] [<a rel="noreferrer">support@predictiveaf.com</a>]</p>
        <hr />
    </div>
</div>
`;
};

app.post("/send-welcome-email", (req, res) => {
  const { client, to, subject, name } = req.body;
  const verificationLink = `https://paf-email.onrender.com/verify-email?token=${to}`;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: welcomeEmailTemplate(client, name, verificationLink),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    res.status(200).send("Email sent: " + info.response);
  });
});

app.get("/verify-email", async function (req, res) {
  const { token } = req.query;
  console.log("Token " + token);
  const { client, user } = await verifyUserAndClient(token);
  sendVerificaitonSuccessEmail(token, user.name, client.name);

  res.status(200).send(verificationSuccess(user.name, client.name));
});

app.post("/send-verify-success", (req, res) => {
  const { client, to, name } = req.body;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: "PAF Verification Success! ",
    html: verificationSuccess(name, client),
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
    .post("http://127.0.0.1:5000/send-verify-success", {
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
      console.error(error);
    });
};
const verifyClient = async (id) => {
  try {
    console.log("Updating client");
    const client = await pb
      .collection("client")
      .getFirstListItem(`manager="${id}"`);
    console.log("Got the client", client.name);
    const record = await pb
      .collection("client")
      .update(client.id, { verified: true });
    console.log("Client verified:", record.verified);

    return record;
  } catch (error) {
    console.log(`Error verifying Client ${error}`);
  }
};

const verifyUserAndClient = async (email) => {
  console.log("verifyUserAndClient ", email);
  try {
    const user = await pb
      .collection("users")
      .getFirstListItem(`email="${email}"`);

    console.log("User", user.name);
    const personel = await pb
      .collection("personel")
      .getFirstListItem(`user="${user.id}"`);
    console.log("Personel", personel.full_name);
    const record = await pb
      .collection("personel")
      .update(personel.id, { verified: true });
    console.log("Personel verified", record);
    const client = await verifyClient(user.id);
    return { client: client, user: user };
  } catch (error) {
    console.log(`Error verifying User ${error}`);
  }
};

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
