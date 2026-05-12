#!/usr/bin/env node
/**
 * Moltbook Auto Post
 *
 * Generates and publishes a post to Moltbook, respecting rate limits.
 * Invoked by cron or manually: node post.js [--dry-run] [--show-history]
 */

import { readFile, writeFile, appendFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Dynamic imports for dependencies
let fetch, dayjs;
try {
  fetch = (await import("node-fetch")).default;
  dayjs = (await import("dayjs")).default;
} catch (err) {
  console.error(
    "[FATAL] Missing dependencies. Run: cd skills/moltbook-auto-post && npm install"
  );
  process.exit(1);
}

// ── Config ────────────────────────────────────────────────────────────
const CONFIG_PATH = join(__dirname, "config.json");
const HISTORY_PATH = join(__dirname, "post-history.json");
const LOG_PATH = join(__dirname, "post.log");

async function loadConfig() {
  const raw = await readFile(CONFIG_PATH, "utf-8");
  const cfg = JSON.parse(raw);
  // env-var override for token
  if (!cfg.moltbook.accessToken && process.env.MOLTBOOK_TOKEN) {
    cfg.moltbook.accessToken = process.env.MOLTBOOK_TOKEN;
  }
  return cfg;
}

// ── Logging ───────────────────────────────────────────────────────────
async function log(level, msg) {
  const ts = dayjs().format("YYYY-MM-DD HH:mm:ss");
  const line = `[${ts}] [${level.toUpperCase()}] ${msg}\n`;
  process.stdout.write(line);
  try {
    await appendFile(LOG_PATH, line);
  } catch {
    /* ignore write errors */
  }
}

// ── History ───────────────────────────────────────────────────────────
async function loadHistory() {
  if (!existsSync(HISTORY_PATH)) return { posts: [] };
  const raw = await readFile(HISTORY_PATH, "utf-8");
  return JSON.parse(raw);
}

async function saveHistory(history) {
  await writeFile(HISTORY_PATH, JSON.stringify(history, null, 2));
}

// ── Rate Limit Check ──────────────────────────────────────────────────
function checkRateLimit(history, config) {
  const now = dayjs();
  const { minIntervalMinutes, maxPostsPerDay } = config.rateLimit;

  // Check minimum interval
  if (history.posts.length > 0) {
    const lastPost = dayjs(history.posts[history.posts.length - 1].timestamp);
    const diffMin = now.diff(lastPost, "minute");
    if (diffMin < minIntervalMinutes) {
      return {
        allowed: false,
        reason: `Last post was ${diffMin}m ago (min interval: ${minIntervalMinutes}m). Next post allowed in ${minIntervalMinutes - diffMin}m.`,
      };
    }
  }

  // Check daily cap
  const todayStart = now.startOf("day");
  const todayPosts = history.posts.filter((p) =>
    dayjs(p.timestamp).isAfter(todayStart)
  );
  if (todayPosts.length >= maxPostsPerDay) {
    return {
      allowed: false,
      reason: `Daily cap reached (${todayPosts.length}/${maxPostsPerDay} posts today).`,
    };
  }

  return { allowed: true };
}

// ── Content Generation ────────────────────────────────────────────────
async function loadTemplates(templateDir) {
  const absDir = join(__dirname, templateDir);
  if (!existsSync(absDir)) return [];

  const files = await readdir(absDir);
  const templates = [];
  for (const f of files) {
    if (f.endsWith(".md") || f.endsWith(".txt")) {
      const content = await readFile(join(absDir, f), "utf-8");
      templates.push({ file: f, content: content.trim() });
    }
  }
  return templates;
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function generateHashtags(topic, max) {
  const base = topic
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.replace(/[^a-z0-9]/g, ""))
    .filter(Boolean);
  const tags = base.slice(0, max).map((t) => `#${t}`);
  return tags.join(" ");
}

async function generateContent(config) {
  const { topics, templateDir, style, maxLength, includeHashtags, maxHashtags } =
    config.content;

  const topic = pickRandom(topics);
  const templates = await loadTemplates(templateDir);

  let body;
  if (templates.length > 0) {
    const tpl = pickRandom(templates);
    body = tpl.content.replace(/\{\{topic\}\}/g, topic);
    await log("info", `Using template: ${tpl.file}`);
  } else {
    // Freeform fallback
    const starters = {
      casual: [
        `Just been thinking about ${topic} lately.`,
        `Hot take on ${topic}:`,
        `Anyone else deep into ${topic} right now?`,
        `Quick thought on ${topic} —`,
      ],
      professional: [
        `Key observations on ${topic}:`,
        `An important development in ${topic}:`,
        `Sharing insights on ${topic}.`,
      ],
      creative: [
        `Imagine a world where ${topic} is everything.`,
        `The ${topic} rabbit hole goes deeper than you think.`,
        `A love letter to ${topic}:`,
      ],
    };
    const pool = starters[style] || starters.casual;
    body = pickRandom(pool);
    await log("info", "No templates found, using freeform generation");
  }

  if (includeHashtags) {
    const tags = generateHashtags(topic, maxHashtags);
    body = `${body}\n\n${tags}`;
  }

  // Truncate if over limit
  if (body.length > maxLength) {
    body = body.slice(0, maxLength - 3) + "...";
  }

  return { body, topic };
}

// ── Moltbook API ──────────────────────────────────────────────────────
async function publishPost(config, content) {
  const { apiBase, accessToken, profileId, defaultVisibility } = config.moltbook;

  if (!accessToken) {
    throw new Error(
      "No access token configured. Set moltbook.accessToken in config.json or MOLTBOOK_TOKEN env var."
    );
  }

  const url = `${apiBase}/profiles/${profileId}/posts`;
  const payload = {
    content: content.body,
    visibility: defaultVisibility,
    metadata: {
      source: "moltbook-auto-post",
      topic: content.topic,
      generatedAt: new Date().toISOString(),
    },
  };

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Moltbook API error (${resp.status}): ${text}`);
  }

  const data = await resp.json();
  return data;
}

// ── Main ──────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const showHistory = args.includes("--show-history");

  const config = await loadConfig();
  const history = await loadHistory();

  if (showHistory) {
    console.log(JSON.stringify(history, null, 2));
    return;
  }

  await log("info", "─── Moltbook Auto Post started ───");
  await log("info", `Mode: ${dryRun ? "DRY RUN" : "LIVE"}`);

  // Rate limit check
  const rlCheck = checkRateLimit(history, config);
  if (!rlCheck.allowed) {
    await log("warn", `Rate limited: ${rlCheck.reason}`);
    process.exit(0);
  }

  // Generate content
  const content = await generateContent(config);
  await log("info", `Generated post (topic: ${content.topic}, ${content.body.length} chars)`);
  await log("info", `Content preview: ${content.body.slice(0, 120)}...`);

  if (dryRun) {
    await log("info", "[DRY RUN] Would publish:");
    console.log(content.body);
    return;
  }

  // Publish
  try {
    const result = await publishPost(config, content);
    await log(
      "info",
      `Published successfully! Post ID: ${result.id || result.postId || "unknown"}`
    );

    // Update history
    history.posts.push({
      timestamp: new Date().toISOString(),
      topic: content.topic,
      postId: result.id || result.postId,
      charCount: content.body.length,
    });

    // Keep only last 100 entries
    if (history.posts.length > 100) {
      history.posts = history.posts.slice(-100);
    }

    await saveHistory(history);
    await log("info", "History updated.");
  } catch (err) {
    await log("error", `Failed to publish: ${err.message}`);

    // Record error for backoff
    history.lastError = {
      timestamp: new Date().toISOString(),
      message: err.message,
    };
    await saveHistory(history);

    process.exit(1);
  }

  await log("info", "─── Moltbook Auto Post finished ───");
}

main().catch(async (err) => {
  await log("error", `Unhandled error: ${err.message}`);
  process.exit(1);
});
