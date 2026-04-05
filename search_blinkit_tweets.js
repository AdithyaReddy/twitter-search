require("dotenv").config();
const { TwitterApi } = require("twitter-api-v2");
const fs = require("fs");
const { spawn } = require("child_process");

// ── Config ────────────────────────────────────────────────────────────────────
const KEYWORD = "Blinkit app";
const MAX_RESULTS_PER_PAGE = 10; // allowed: 10–100 for recent-search endpoint

// ── Twitter client (read-only, Bearer Token) ──────────────────────────────────
const client = new TwitterApi(process.env.TWITTER_BEARER_TOKEN, { wait_on_rate_limit: true });
const roClient = client.readOnly;

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Pause execution for `ms` milliseconds. */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * If the API error is a 429, reads the x-rate-limit-reset header and waits
 * until the window resets (+ a 2-second safety buffer), then resolves.
 * For any other error it re-throws immediately.
 */
async function handleRateLimit(err) {
  if (err?.code !== 429 && err?.status !== 429) throw err;

  const resetUnix = err?.rateLimit?.reset; // seconds since Unix epoch
  const waitMs = resetUnix
    ? Math.max(resetUnix * 1000 - Date.now(), 0) + 2_000 // +2 s buffer
    : 60_000; // fallback: wait 60 s if header is missing

  const resetAt = new Date(
    (resetUnix ?? Date.now() / 1000 + 60) * 1000
  ).toISOString();

  console.warn(
    `⏳  Rate limited. Resuming after ${resetAt}  (~${Math.ceil(waitMs / 1000)} s)…`
  );
  await sleep(waitMs);
}

/** Returns ISO-8601 start/end strings for yesterday (UTC 00:00:00 → 23:59:59). */
function getYesterdayRange() {
  const now = new Date();
  const startOfYesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1)
  );
  const endOfYesterday = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - 1
  ); // 1ms before today's midnight = yesterday 23:59:59.999
  return {
    start: startOfYesterday.toISOString(),
    end: endOfYesterday.toISOString(),
  };
}

/** Formats a single tweet as a plain-text block for file output.
 *  NOTE: emoji prefixes (🕐, 🆔, ❤️) must stay in sync with
 *  the parser in filter_app_feedback.js. */
function formatTweet(tweet, index, authorMap) {
  const author = authorMap[tweet.author_id] ?? { name: "Unknown", username: "unknown" };
  const divider = "─".repeat(60);
  const lines = [
    `\n${divider}`,
    `  #${index + 1}  @${author.username} (${author.name})`,
    `  🕐  ${tweet.created_at}`,
    `  🆔  ${tweet.id}`,
    `\n  ${tweet.text.replace(/\n/g, "\n  ")}`,
  ];
  if (tweet.public_metrics) {
    const m = tweet.public_metrics;
    lines.push(`\n  ❤️  ${m.like_count}  🔁 ${m.retweet_count}  💬 ${m.reply_count}`);
  }
  return lines.join("\n");
}

/** Pretty-prints a single tweet. */
function printTweet(tweet, index, authorMap) {
  const author = authorMap[tweet.author_id] ?? { name: "Unknown", username: "unknown" };
  const divider = "─".repeat(60);
  console.log(`\n${divider}`);
  console.log(`  #${index + 1}  @${author.username} (${author.name})`);
  console.log(`  🕐  ${tweet.created_at}`);
  console.log(`  🆔  ${tweet.id}`);
  console.log(`\n  ${tweet.text.replace(/\n/g, "\n  ")}`);
  if (tweet.public_metrics) {
    const m = tweet.public_metrics;
    console.log(
      `\n  ❤️  ${m.like_count}  🔁 ${m.retweet_count}  💬 ${m.reply_count}  👁️  ${m.impression_count ?? "N/A"}`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { start, end } = getYesterdayRange();

  console.log(`\n🔍  Searching Twitter for: "${KEYWORD}"`);
  console.log(`📅  Date range (UTC): ${start}  →  ${end}\n`);

  const query =
    `${KEYWORD} lang:en -is:retweet`;   // tweak filters as needed
    

  const DELAY_BETWEEN_PAGES_MS = 2_000; // 1 s pause between pages
  const MAX_RETRIES = 1;

  const searchOptions = {
    start_time: start,
    end_time: end,
    max_results: MAX_RESULTS_PER_PAGE,
    "tweet.fields": ["created_at", "author_id", "text", "public_metrics"],
    "user.fields": ["name", "username"],
    expansions: ["author_id"],
  };

  // Collect every page using manual pagination so each page can be retried
  const allTweets = [];
  const authorMap = {}; // author_id → { name, username }
  let pageNum = 0;

  // Fetch the first page (with retry)
  let paginator;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      paginator = await roClient.v2.searchAll(query, searchOptions);
      break;
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      await handleRateLimit(err);
    }
  }

  // Walk through all pages.
  // paginator.fetchNext() is the correct way to advance pages in twitter-api-v2.
  // [...paginator] uses Symbol.iterator to get the current page's tweets.
  // paginator.next() (async iterator) returns {value, done} — NOT the raw page — so we avoid it.
  while (true) {
    pageNum++;

    // Current page's includes (users, media, etc.)
    const users = paginator.includes?.users ?? [];
    for (const u of users) {
      authorMap[u.id] = { name: u.name, username: u.username };
    }
    console.log(`author mapping done`);
    // Spread the current page's tweets via the sync iterator
    const tweets = [...paginator];
    console.log(`paginator mapping done`);
    allTweets.push(...tweets);
    console.log(`  📄  Page ${pageNum}: fetched ${tweets.length} tweet(s)  (total so far: ${allTweets.length})`);

    // Stop if no more pages
    if (paginator.done) break;

    // Polite delay before the next page fetch
    await sleep(DELAY_BETWEEN_PAGES_MS);

    // Advance to the next page (with retry on 429)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await paginator.fetchNext();
        break;
      } catch (err) {
        if (attempt === MAX_RETRIES) throw err;
        await handleRateLimit(err);
      }
    }
  }

  if (allTweets.length === 0) {
    console.log("⚠️  No tweets found for yesterday.");
    return;
  }

  console.log(`✅  Found ${allTweets.length} tweet(s) yesterday mentioning "${KEYWORD}"\n`);

  // Sort oldest → newest
  allTweets.sort(
    (a, b) => new Date(a.created_at) - new Date(b.created_at)
  );

  allTweets.forEach((tweet, i) => printTweet(tweet, i, authorMap));

  console.log("\n" + "─".repeat(60));
  console.log(`\n📊  Total tweets: ${allTweets.length}`);

  // Write tweets to a dated .txt file
  const dateStr = start.slice(0, 10); // e.g. "2026-04-02"
  const filename = `blinkit_tweets_${dateStr}.txt`;
  const header = `Blinkit tweets for ${dateStr}\nFetched: ${new Date().toISOString()}\nTotal: ${allTweets.length}\n`;
  const body = allTweets.map((t, i) => formatTweet(t, i, authorMap)).join("\n");
  fs.writeFileSync(filename, header + body + "\n");
  console.log(`\n💾  Saved to ${filename}`);

  // Run filter_app_feedback.js with the saved file as input
  console.log(`\n🚀  Running filter_app_feedback.js on ${filename}...\n`);
  await new Promise((resolve, reject) => {
    const child = spawn("node", ["filter_app_feedback.js", filename], {
      stdio: "inherit", // stream output directly to this terminal
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`filter_app_feedback.js exited with code ${code}`));
    });
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error("❌  Error:", err?.data ?? err.message ?? err);
    process.exit(1);
  });
}

module.exports = { main };
