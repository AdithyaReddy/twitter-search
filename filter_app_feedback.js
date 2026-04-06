require("dotenv").config();
const fs = require("fs");
const Anthropic = require("@anthropic-ai/sdk").default;

// ── Config ────────────────────────────────────────────────────────────────────
const INPUT_FILE = process.argv[2] || "blinkit_tweets_2026-04-02.txt";
const outputDir = process.env.OUTPUT_DIR || "/tmp";
const OUTPUT_FILE = `${outputDir}/final-app-feedback-tweets.txt`;
const BATCH_SIZE = 20; // tweets per Claude API call

const SEPARATOR = "─".repeat(60);

const client = new Anthropic(); // uses ANTHROPIC_API_KEY from .env

// ── Parse tweets file ─────────────────────────────────────────────────────────

function parseTweets(content) {
  // Split on the ─── separator lines (50+ dashes)
  const blocks = content.split(/\n?─{50,}\n?/);
  const tweets = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const text = extractTweetText(trimmed);
    if (!text) continue;

    tweets.push({ raw: block, text });
  }

  return tweets;
}

function extractTweetText(block) {
  const lines = block.split("\n");
  let pastId = false;
  const textLines = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip header lines
    if (/^#\d+\s+@/.test(trimmed)) continue;

    // Timestamp line (emoji or plain ISO date)
    if (trimmed.startsWith("🕐")) continue;
    if (/^\d{4}-\d{2}-\d{2}T/.test(trimmed)) continue;

    // ID line — marks the start of tweet text (emoji or plain "ID: ...")
    if (trimmed.startsWith("🆔") || trimmed.startsWith("ID:")) { pastId = true; continue; }

    // Metrics line — marks the end of tweet text (emoji or plain "Likes: ...")
    if (trimmed.startsWith("❤️") || trimmed.startsWith("Likes:")) break;

    if (pastId && trimmed) {
      textLines.push(trimmed);
    }
  }

  return textLines.join(" ").trim();
}

// ── Classify a batch of tweets with Claude ────────────────────────────────────

async function classifyBatch(tweets) {
  const tweetList = tweets
    .map((t, i) => `Tweet #${i + 1}:\n${t.text}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: "claude-opus-4-6",
    max_tokens: 1024,
    system: `You are a tweet classifier for Blinkit, a quick-commerce delivery app.

Your job: identify which tweets contain app-related feedback.

App-related feedback includes ANY of the following:
- App bugs or crashes ("app crashed", "force close", "not working", "error")
- UI/UX issues ("confusing", "bad design", "can't find", "button not working")
- Order tracking within the app ("tracking page broken", "can't see order status")
- Login or account issues ("can't log in", "OTP not received", "account issue")
- Payment issues within the app ("payment failing", "checkout broken", "can't pay")
- App performance ("app is slow", "loading forever", "infinite spinner", "lag")
- Feature requests or missing features in the app
- General app experience complaints or praise

Do NOT include tweets about:
- Delivery speed or late orders (unless also mentioning app tracking)
- Product quality, pricing, or availability
- Delivery personnel behaviour
- General brand sentiment without app mention

Respond ONLY with valid JSON in this exact format:
{"app_feedback_indices": [1, 3, 5]}

Use the tweet numbers as listed. If none qualify, return: {"app_feedback_indices": []}`,
    messages: [
      {
        role: "user",
        content: `Classify these ${tweets.length} tweets:\n\n${tweetList}`,
      },
    ],
  });

  const text = response.content.find((b) => b.type === "text")?.text ?? "{}";

  try {
    const parsed = JSON.parse(text);
    return parsed.app_feedback_indices ?? [];
  } catch {
    console.error("  ⚠️  Failed to parse JSON response:", text);
    return [];
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌  Input file not found: ${INPUT_FILE}`);
    process.exit(1);
  }

  const content = fs.readFileSync(INPUT_FILE, "utf8");
  const tweets = parseTweets(content);

  console.log(`\n📂 ${INPUT_FILE} ${content}`);
  if (tweets.length === 0) {
    console.log("⚠️  No tweets found in the input file.");
    return;
  }

  console.log(`\n📂  Loaded ${tweets.length} tweets from ${INPUT_FILE}`);
  console.log(`🔍  Filtering for app-related feedback using Claude...\n`);

  const appFeedbackTweets = [];
  const totalBatches = Math.ceil(tweets.length / BATCH_SIZE);

  for (let i = 0; i < tweets.length; i += BATCH_SIZE) {
    const batch = tweets.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    process.stdout.write(
      `  📄  Batch ${batchNum}/${totalBatches} (tweets ${i + 1}–${Math.min(i + BATCH_SIZE, tweets.length)})... `
    );

    const indices = await classifyBatch(batch);
    const matched = indices.map((idx) => batch[idx - 1]).filter(Boolean);
    appFeedbackTweets.push(...matched);

    console.log(`${matched.length} app feedback tweet(s) found`);
  }

  console.log(`\n✅  Found ${appFeedbackTweets.length} app-related feedback tweet(s) out of ${tweets.length} total\n`);

  // Write output file
  const outputLines = appFeedbackTweets.map((t) => SEPARATOR + "\n" + t.raw.trim());
  const outputContent = outputLines.join("\n\n") + (outputLines.length ? "\n\n" + SEPARATOR + "\n" : "");

  fs.writeFileSync(OUTPUT_FILE, outputContent, "utf8");
  console.log(`💾  Saved to ${OUTPUT_FILE}`);

  // Print summary to console
  if (appFeedbackTweets.length > 0) {
    console.log("\n── Preview of filtered tweets ──\n");
    appFeedbackTweets.slice(0, 5).forEach((t) => {
      console.log(`  • ${t.text.slice(0, 120)}${t.text.length > 120 ? "…" : ""}`);
    });
    if (appFeedbackTweets.length > 5) {
      console.log(`  … and ${appFeedbackTweets.length - 5} more (see ${OUTPUT_FILE})`);
    }
  }
}

main().catch((err) => {
  console.error("❌  Error:", err?.message ?? err);
  process.exit(1);
});
