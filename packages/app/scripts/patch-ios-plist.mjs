#!/usr/bin/env node
// Patches the Capacitor-generated iOS Info.plist for continuous-chat
// support (R10 §6.1) and the explicit iOS remote-push build gate.
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
import { ensurePlistUrlScheme } from "../../app-core/scripts/lib/ios-plist-url-scheme.mjs";
import { readAppIdentity } from "../../app-core/scripts/lib/read-app-identity.mjs";
import {
  IOS_APNS_ENABLED_KEY,
  IOS_MICROPHONE_USAGE_DESCRIPTION,
  IOS_SPEECH_RECOGNITION_USAGE_DESCRIPTION,
  readIosApnsBuildFlag,
} from "../../app-core/scripts/mobile/ios-plist.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_DIR = resolve(__dirname, "..");

const APNS_ENABLED_KEY = IOS_APNS_ENABLED_KEY;

const KEYS =
  /** @type {Array<{ key: string; value: string | string[] | boolean }>} */ ([
    { key: "UIBackgroundModes", value: ["audio"] },
    {
      key: "NSMicrophoneUsageDescription",
      value: IOS_MICROPHONE_USAGE_DESCRIPTION,
    },
    {
      key: "NSSpeechRecognitionUsageDescription",
      value: IOS_SPEECH_RECOGNITION_USAGE_DESCRIPTION,
    },
    // Live Activities for the voice/dictation session (#12185 D10). Kept in
    // sync with the app-core merger (scripts/mobile/ios-plist.mjs) so the two
    // plist patchers agree.
    { key: "NSSupportsLiveActivities", value: true },
  ]);

const TARGET_PATH = resolve(__dirname, "..", "ios", "App", "App", "Info.plist");

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
    const items = value
      .map((v) => `\t\t<string>${escapeXml(v)}</string>`)
      .join("\n");
    return `\t<key>${key}</key>\n\t<array>\n${items}\n\t</array>\n`;
  }
  if (typeof value === "boolean") {
    return `\t<key>${key}</key>\n\t<${value ? "true" : "false"}/>\n`;
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

function ensureArrayStringValue(xml, key, value) {
  const keyPattern = `<key>${escapeKey(key)}</key>`;
  const blockPattern = new RegExp(
    `(${keyPattern}\\s*<array>)([\\s\\S]*?)(\\s*</array>)`,
  );
  const match = xml.match(blockPattern);
  if (!match) {
    return { next: xml, changed: false };
  }
  const [, prefix, body, suffix] = match;
  if (
    new RegExp(`<string>${escapeKey(escapeXml(value))}</string>`).test(body)
  ) {
    return { next: xml, changed: false };
  }
  const indent = body.match(/\n(\s*)<string>/)?.[1] ?? "\t\t";
  const insertedBody = `${body}\n${indent}<string>${escapeXml(value)}</string>`;
  return {
    next: xml.replace(blockPattern, `${prefix}${insertedBody}${suffix}`),
    changed: true,
  };
}

function ensureStringValue(xml, key, value) {
  const keyPattern = `<key>${escapeKey(key)}</key>`;
  const valuePattern = new RegExp(
    `(${keyPattern}\\s*<string>)([\\s\\S]*?)(</string>)`,
  );
  const match = xml.match(valuePattern);
  if (!match) {
    if (hasKey(xml, key)) {
      throw new Error(`Info.plist: ${key} must be a string`);
    }
    return { next: xml, changed: false };
  }
  if (match[2] === value) return { next: xml, changed: false };
  return {
    next: xml.replace(valuePattern, `$1${escapeXml(value)}$3`),
    changed: true,
  };
}

function readApnsBuildFlag(raw = process.env.VITE_ELIZA_APNS_ENABLED) {
  return readIosApnsBuildFlag(raw);
}

function patchPlist(xml, urlScheme, { apnsEnabled = false } = {}) {
  let changed = false;
  let next = xml;
  const entries = [
    ...KEYS,
    { key: APNS_ENABLED_KEY, value: apnsEnabled ? "1" : "0" },
  ];
  for (const entry of entries) {
    if (hasKey(next, entry.key)) {
      if (Array.isArray(entry.value)) {
        for (const value of entry.value) {
          const result = ensureArrayStringValue(next, entry.key, value);
          next = result.next;
          changed = changed || result.changed;
        }
      } else if (entry.key === APNS_ENABLED_KEY) {
        const result = ensureStringValue(next, entry.key, entry.value);
        next = result.next;
        changed = changed || result.changed;
      }
      continue;
    }
    const insertAt = findInsertionPoint(next);
    next = next.slice(0, insertAt) + renderEntry(entry) + next.slice(insertAt);
    changed = true;
  }
  const nextWithScheme = ensurePlistUrlScheme(next, urlScheme);
  if (nextWithScheme !== next) {
    next = nextWithScheme;
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
    console.log(
      `[patch-ios-plist] no Info.plist found at ${TARGET_PATH} — skipping.`,
    );
    return;
  }
  const original = readFileSync(TARGET_PATH, "utf8");
  const { urlScheme } = readAppIdentity(APP_DIR);
  const { next, changed } = patchPlist(original, urlScheme, {
    apnsEnabled: readApnsBuildFlag(),
  });
  if (!changed) {
    console.log("[patch-ios-plist] all keys already present — no changes.");
    return;
  }
  writeFileSync(TARGET_PATH, next);
  console.log(
    "[patch-ios-plist] patched iOS background, permission, APNs, and URL-scheme configuration.",
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
  const { urlScheme } = readAppIdentity(APP_DIR);
  const apnsEnabled = readApnsBuildFlag();
  const patched = patchPlist(xml, urlScheme, { apnsEnabled });
  const missingUrlScheme = ensurePlistUrlScheme(xml, urlScheme) !== xml;
  if (!patched.changed && !missingUrlScheme) {
    console.log("[patch-ios-plist] OK — all required keys present.");
    process.exit(0);
  }
  const missing = KEYS.filter((k) => !hasKey(xml, k.key));
  const expectedApnsValue = apnsEnabled ? "1" : "0";
  const apnsMismatch =
    !hasKey(xml, APNS_ENABLED_KEY) ||
    ensureStringValue(xml, APNS_ENABLED_KEY, expectedApnsValue).changed;
  const incompleteArrays = KEYS.flatMap((entry) => {
    if (!Array.isArray(entry.value) || !hasKey(xml, entry.key)) return [];
    return entry.value
      .filter((value) => ensureArrayStringValue(xml, entry.key, value).changed)
      .map((value) => `${entry.key}:${value}`);
  });
  console.error(
    `[patch-ios-plist] missing keys: ${[
      ...missing.map((k) => k.key),
      ...incompleteArrays,
      ...(apnsMismatch ? [`${APNS_ENABLED_KEY}:${expectedApnsValue}`] : []),
      ...(missingUrlScheme ? [`CFBundleURLTypes:${urlScheme}`] : []),
    ].join(", ")}`,
  );
  process.exit(1);
}

main();

// Exports for tests.
export {
  APNS_ENABLED_KEY,
  findInsertionPoint,
  hasKey,
  KEYS,
  patchPlist,
  readApnsBuildFlag,
};
