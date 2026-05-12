#!/usr/bin/env node
"use strict";

const fs = require("fs");
const path = require("path");
const { MoltbookClient } = require("./lib/client");
const { RateLimiter } = require("./lib/rate-limiter");
const { ContentPicker } = require("./lib/content-picker");
const { loadConfig } = require("./lib/config");

const SKILL_DIR = __dirname;
const STATE_FILE = path.join(SKILL_DIR, "state.json");
const QUEUE_DIR = path.join(SKILL_DIR, "queue");
const LOG_DIR = path.join(SKILL_DIR, "logs");

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return {
      lastPostAt: null,
      postsToday: 0,
      todayDate: null,
      apiCallsThisHour: 0,
      hourStart: null,
      totalPostsLifetime: 0,
    };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function appendLog(entry) {
  const today = new Date().toISOString().slice(0, 10);
  const logFile = path.join(LOG_DIR, `${today}.jsonl`);
  fs.mkdirSync(LOG_DIR, { recursive: true });
  fs.appendFileSync(logFile, JSON.stringify(entry) + "\n", "utf8");
}

async function main() {
  const config = loadConfig();
  const state = loadState();
  const now = new Date();
  const today = now.toISOString().slice(0, 10);

  // Reset daily counters
  if (state.todayDate !== today) {
    state.todayDate = today;
    state.postsToday = 0;
  }

  // Reset hourly API counter
  const currentHour = now.toISOString().slice(0, 13);
  if (state.hourStart !== currentHour) {
    state.hourStart = currentHour;
    state.apiCallsThisHour = 0;
  }

  // Check rate limits
  const limiter = new RateLimiter(config, state);
  if (!limiter.canPost()) {
    const reason = limiter.getBlockReason();
    console.log(`[moltbook-auto-post] Skipping: ${reason}`);
    appendLog({
      ts: now.toISOString(),
      action: "skip",
      reason,
    });
    saveState(state);
    process.exit(0);
  }

  // Check minimum interval
  if (state.lastPostAt) {
    const elapsed = (now - new Date(state.lastPostAt)) / 60000;
    if (elapsed < (config.postIntervalMin || 60)) {
      console.log(
        `[moltbook-auto-post] Too soon since last post (${elapsed.toFixed(1)}m < ${config.postIntervalMin || 60}m)`
      );
      appendLog({
        ts: now.toISOString(),
        action: "skip",
        reason: "interval_too_short",
        elapsedMin: elapsed,
      });
      saveState(state);
      process.exit(0);
    }
  }

  // Pick content
  const picker = new ContentPicker(config, QUEUE_DIR, SKILL_DIR);
  const content = await picker.pick();

  if (!content) {
    console.log("[moltbook-auto-post] No content available to post.");
    appendLog({
      ts: now.toISOString(),
      action: "skip",
      reason: "no_content",
    });
    saveState(state);
    process.exit(0);
  }

  // Post to Moltbook
  const client = new MoltbookClient(config);

  try {
    console.log(`[moltbook-auto-post] Posting: "${content.text.slice(0, 80)}..."`);

    let mediaIds = [];
    if (content.media && content.media.length > 0) {
      for (const mediaPath of content.media) {
        const id = await client.uploadMedia(mediaPath);
        mediaIds.push(id);
        state.apiCallsThisHour++;
      }
    }

    const result = await client.createPost({
      text: content.text,
      mediaIds,
      tags: content.tags || [],
      visibility: content.visibility || config.defaultVisibility || "public",
    });

    state.apiCallsThisHour++;
    state.lastPostAt = now.toISOString();
    state.postsToday++;
    state.totalPostsLifetime++;

    console.log(`[moltbook-auto-post] Posted successfully! ID: ${result.postId}`);
    appendLog({
      ts: now.toISOString(),
      action: "post",
      postId: result.postId,
      textPreview: content.text.slice(0, 120),
      tags: content.tags,
      mediaCount: mediaIds.length,
    });

    // Remove from queue if it came from there
    if (content._queueFile) {
      fs.unlinkSync(content._queueFile);
      console.log(`[moltbook-auto-post] Removed queued item: ${path.basename(content._queueFile)}`);
    }
  } catch (err) {
    console.error(`[moltbook-auto-post] Error posting: ${err.message}`);
    appendLog({
      ts: now.toISOString(),
      action: "error",
      error: err.message,
      statusCode: err.statusCode || null,
    });

    if (err.statusCode === 429) {
      state.apiCallsThisHour = 60; // Force cooldown
      console.log("[moltbook-auto-post] Rate limited. Forcing cooldown.");
    }
  }

  saveState(state);
}

main().catch((err) => {
  console.error(`[moltbook-auto-post] Fatal: ${err.message}`);
  process.exit(1);
});
