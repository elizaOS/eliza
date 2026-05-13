"use strict";

const fs = require("fs");
const path = require("path");

function loadConfig() {
  const skillDir = path.join(__dirname, "..");
  const envPath = path.join(skillDir, ".env");
  if (fs.existsSync(envPath)) {
    require("dotenv").config({ path: envPath });
  }

  return {
    contentMode: (process.env.CONTENT_MODE || "hybrid").toLowerCase(),
    postIntervalMin: parseInt(process.env.POST_INTERVAL_MIN || "60", 10),
    maxPostsPerDay: parseInt(process.env.MAX_POSTS_PER_DAY || "8", 10),
    maxApiCallsPerHour: parseInt(process.env.MAX_API_CALLS_PER_HOUR || "55", 10),
    defaultVisibility: process.env.DEFAULT_VISIBILITY || "public",
    moltbookApiKey: process.env.MOLTBOOK_API_KEY || "",
    moltbookApiSecret: process.env.MOLTBOOK_API_SECRET || "",
    moltbookUserId: process.env.MOLTBOOK_USER_ID || "",
    moltbookAccessToken: process.env.MOLTBOOK_ACCESS_TOKEN || "",
  };
}

module.exports = { loadConfig };
