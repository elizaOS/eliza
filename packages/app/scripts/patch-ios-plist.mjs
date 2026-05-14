#!/usr/bin/env node
// Patches the Capacitor-generated iOS Info.plist for continuous-chat
// support (R10 §6.1).
//
// Capacitor regenerates ios/App/App/Info.plist on `cap sync`; this script
// runs after `cap sync ios` and idempotently inserts the keys the voice
// stack needs:
//
//   UIBackgroundModes = ["audio"]
//   NSMicrophoneUsageDescription
//   NSSpeechRecognitionUsageDescription
//
// Without `UIBackgroundModes = audio` the AVAudioSession the TalkMode
// plugin configures (.playAndRecord / .voiceChat with .mixWithOthers +
// .duckOthers) is paused when the screen locks. With it, the session
// survives lock and continuous-chat keeps working end-to-end.
//
// The script is intentionally a small XML-aware text patcher rather than
// pulling in a plist parser. The schema is well-defined and Capacitor
// generates the same `<dict>` layout every sync; we look for the keys we
// own, add them if missing, leave anything else untouched.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIC_PURPOSE =
  "Eliza listens when you talk to your agent.";
const SPEECH_PURPOSE =
  "Eliza transcribes your speech so you can talk to the agent.";

const KEYS = /** @type {Array<{ key: string; value: string | string[] }>} */ ([
  { key: "UIBackgroundModes", value: ["audio"] },
  { key: "NSMicrophoneUsageDescription", value: MIC_PURPOSE },
  { key: "NSSpeechRecognitionUsageDescription", value: SPEECH_PURPOSE },
]);

const TARGET_PATH = resolve(
  __dirname,
  "..",
  "ios",
  "App",
  "App",
  "Info.plist",
);

function findInsertionPoint(xml) {
  // Insert before the closing `</dict>` of the top-level `<plist>`. The
  // generated file always has exactly one top-level dict; we anchor on
  // the last `</dict>` followed by `</plist>`.
  const m = xml.match(/<\/dict>\s*<\/plist>/);
  if (!m || typeof m.index !== "number") {
    throw new Error("Info.plist: could not locate top-level </dict>");
  }
  return m.index;
}

function hasKey(xml, key) {
  return new RegExp(`<key>${escapeKey(key)}</key>`).test(xml);
}

function escapeKey(key) {
  return key.replace(/[-\\^$*+?.()|[\]{}]/g, "\\$&");
}

function renderEntry({ key, value }) {
  if (Array.isArray(value)) {
    const items = value.map((v) => `\t\t<string>${escapeXml(v)}</string>`).join("\n");
    return `\t<key>${key}</key>\n\t<array>\n${items}\n\t</array>\n`;
  }
  return `\t<key>${key}</key>\n\t<string>${escapeXml(value)}</string>\n`;
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function patchPlist(xml) {
  let changed = false;
  let next = xml;
  for (const entry of KEYS) {
    if (hasKey(next, entry.key)) continue;
    const insertAt = findInsertionPoint(next);
    next = next.slice(0, insertAt) + renderEntry(entry) + next.slice(insertAt);
    changed = true;
  }
  return { next, changed };
}

function main() {
  if (!existsSync(TARGET_PATH)) {
    // Not a failure: this script is wired into `cap sync ios`; on
    // workspaces that haven't generated the iOS platform yet (CI Linux
    // workers, fresh checkouts that only target web/desktop), there's
    // nothing to patch and we exit cleanly.
    console.log(`[patch-ios-plist] no Info.plist found at ${TARGET_PATH} — skipping.`);
    return;
  }
  const original = readFileSync(TARGET_PATH, "utf8");
  const { next, changed } = patchPlist(original);
  if (!changed) {
    console.log("[patch-ios-plist] all keys already present — no changes.");
    return;
  }
  writeFileSync(TARGET_PATH, next);
  console.log(
    "[patch-ios-plist] patched UIBackgroundModes + microphone/speech usage descriptions.",
  );
}

// Allow `node patch-ios-plist.mjs --check` to verify without writing.
const checkOnly = process.argv.includes("--check");
if (checkOnly) {
  if (!existsSync(TARGET_PATH)) {
    console.log("[patch-ios-plist] no Info.plist; nothing to check.");
    process.exit(0);
  }
  const xml = readFileSync(TARGET_PATH, "utf8");
  const missing = KEYS.filter((k) => !hasKey(xml, k.key));
  if (missing.length === 0) {
    console.log("[patch-ios-plist] OK — all required keys present.");
    process.exit(0);
  }
  console.error(
    `[patch-ios-plist] missing keys: ${missing.map((k) => k.key).join(", ")}`,
  );
  process.exit(1);
}

main();

// Exports for tests.
export { findInsertionPoint, hasKey, KEYS, patchPlist };
