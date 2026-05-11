// ios-os stub for the iOS Bun-port agent bundle.
//
// Routes os.homedir() / os.tmpdir() to the iOS app sandbox via
// environment variables set by ElizaBunRuntime.swift at startup:
//
//   ELIZA_IOS_HOME           → ~/Library/Application Support/Milady/
//   ELIZA_IOS_TMP            → NSTemporaryDirectory()
//   ELIZA_IOS_DOCUMENTS      → ~/Documents/
//   ELIZA_IOS_CACHES         → ~/Library/Caches/Milady/
//   ELIZA_IOS_APP_SUPPORT    → ~/Library/Application Support/Milady/
//
// The host (Swift code) sets these before bun_embedded_run() so any code
// that calls os.homedir() gets a sandbox-correct path without needing to
// know it's running on iOS.
//
// Falls back to the real `node:os` module when the env vars aren't set —
// useful for desktop dev / Android where this stub is not loaded.
"use strict";

const realOs = require("node:os");

function pickEnv(key, fallback) {
  const v = process.env[key];
  return typeof v === "string" && v.length > 0 ? v : fallback;
}

module.exports = {
  ...realOs,
  homedir: () => pickEnv("ELIZA_IOS_APP_SUPPORT", realOs.homedir()),
  tmpdir: () => pickEnv("ELIZA_IOS_TMP", realOs.tmpdir()),
  platform: () => "ios",
  type: () => "Darwin",
  release: () => pickEnv("ELIZA_IOS_VERSION", realOs.release()),
  hostname: () => pickEnv("ELIZA_IOS_HOSTNAME", "ios-device"),
  // arch, cpus, totalmem, freemem, networkInterfaces all defer to the real
  // module — they work correctly on iOS via standard syscalls.
};

module.exports.default = module.exports;
