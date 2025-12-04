const nodemailer = require("nodemailer");

exports.handler = async (event, context) => {
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  const { to, subject, html } = JSON.parse(event.body);

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER, // Pulled from Netlify Settings
      pass: process.env.EMAIL_PASS  // Pulled from Netlify Settings
    }
  });

  try {
    await transporter.sendMail({
      from: `"Proof Buddy" <${process.env.EMAIL_USER}>`,
      to: to,
      subject: subject,
      html: html
    });

    return { statusCode: 200, body: "Email sent" };
  } catch (error) {
    return { statusCode: 500, body: error.toString() };
  }
};