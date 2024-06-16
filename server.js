const express = require("express");
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
const emailTemplate = (name, verificationLink) => `
<h1>Hello, ${name}</h1>
<p>Please click the link below to verify your email address:</p>
<a href="${verificationLink}" style="display: inline-block; padding: 10px 20px; font-size: 16px; color: #fff; background-color: #007bff; text-decoration: none; border-radius: 5px;">Verify Email</a>
`;

app.post("/send-email", (req, res) => {
  const { to, subject, name, message } = req.body;
  console.log(to, subject, name, message);
  const verificationLink = `https://paf-email.onrender.com/verify-email?token=${to}`;
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: emailTemplate(name, verificationLink),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    res.status(200).send("Email sent: " + info.response);
  });
});

app.post("/verify-email", async function (req, res) {
  const { token } = req.query;
  console.log("Token" + token);
  await verifyUser(token);

  res.status(200).send("User Verified: ");
});

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

const verifyUser = async (email) => {
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
    const done = await verifyClient(user.id);
    return done;
  } catch (error) {
    console.log(`Error verifying User ${error}`);
  }
};

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
