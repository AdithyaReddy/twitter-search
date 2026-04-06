const { main } = require("../search_blinkit_tweets");
const { Resend } = require("resend");
const fs = require("fs");

module.exports = async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await main();

    const dateStr = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10); // yesterday
    const filteredFile = `/tmp/final-app-feedback-tweets.txt`;
    const content = fs.existsSync(filteredFile)
      ? fs.readFileSync(filteredFile, "utf8")
      : "No app feedback tweets found for yesterday.";

    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: process.env.EMAIL_FROM,
      to: process.env.EMAIL_TO,
      subject: `Blinkit App Feedback Digest — ${dateStr}`,
      text: content,
    });

    console.log(`📧  Email digest sent for ${dateStr}`);
    return res.status(200).json({ message: "OK", date: dateStr });
  } catch (err) {
    console.error("❌  Cron error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "Internal server error" });
  }
};
