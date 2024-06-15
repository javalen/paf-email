const express = require("express");
const nodemailer = require("nodemailer");
const bodyParser = require("body-parser");
const cors = require("cors");

const app = express();
app.use(bodyParser.json());
app.use(cors());

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
const emailTemplate = (name, message) => `
    <h1>Hello, ${name}</h1>
    <p>${message}</p>
`;

app.post("/send-email", (req, res) => {
  const { to, subject, name, message } = req.body;
  console.log(to, subject, name, message);
  const mailOptions = {
    from: "support@predictiveaf.com",
    to: to,
    subject: subject,
    html: emailTemplate(name, message),
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return res.status(500).send(error.toString());
    }
    res.status(200).send("Email sent: " + info.response);
  });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
