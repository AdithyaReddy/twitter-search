const { main } = require("../search_blinkit_tweets");

module.exports = async (req, res) => {
  const authHeader = req.headers["authorization"];
  if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  try {
    await main();
    return res.status(200).json({ message: "OK" });
  } catch (err) {
    console.error("❌  Cron error:", err?.message ?? err);
    return res.status(500).json({ error: err?.message ?? "Internal server error" });
  }
};
