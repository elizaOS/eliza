/**
 * Evidence artifact discovery and screenshot heuristics for the local reviewer.
 * The generator keeps filesystem and HTML output in `generate.mjs`; this module
 * holds the small pure pieces so the dashboard's classification rules have
 * focused tests.
 */

import path from "node:path";
import { analyzeImageFile as analyzeSharedImageFile } from "@elizaos/evidence/visual-primitives";

export const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".m4v"]);
export const LOG_EXTENSIONS = new Set([".log", ".txt", ".out", ".err"]);
export const REPORT_EXTENSIONS = new Set([
  ".json",
  ".jsonl",
  ".xml",
  ".html",
  ".md",
]);
export const ARCHIVE_EXTENSIONS = new Set([".zip"]);
const ANSI_ESCAPE_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "g",
);

export function htmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function toPosixPath(value) {
  return String(value).split(path.sep).join("/");
}

export function classifyArtifactPath(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (VIDEO_EXTENSIONS.has(ext)) return "video";
  if (LOG_EXTENSIONS.has(ext)) return "log";
  if (ARCHIVE_EXTENSIONS.has(ext)) return "archive";
  if (REPORT_EXTENSIONS.has(ext)) {
    if (ext === ".jsonl" || /trajectory|llm-calls/i.test(filePath)) {
      return "trajectory";
    }
    if (ext === ".html") return "viewer";
    return "report";
  }
  return null;
}

export function inferSource(root, filePath) {
  const rel = toPosixPath(path.relative(root, filePath));
  if (rel.startsWith("evidence/")) return "evidence";
  if (rel.startsWith("e2e-recordings/")) return "e2e-recordings";
  if (rel.startsWith("device-e2e-output/")) return "device-e2e";
  if (rel.startsWith("packages/app/aesthetic-audit-output/")) {
    return "app-audit";
  }
  if (rel.startsWith("packages/app/device-e2e-output/")) return "device-e2e";
  if (rel.startsWith("packages/app/ios/build/boot-capture/")) {
    return "ios-boot-capture";
  }
  if (rel.startsWith("packages/app/ios/build/device-logs/")) {
    return "ios-device-logs";
  }
  if (rel.startsWith("packages/app/test-results/")) return "app-test-results";
  if (rel.startsWith("packages/app/reports/walkthrough/")) {
    return "walkthrough";
  }
  if (rel.startsWith("packages/scenario-runner/reports/")) {
    return "scenario-runner";
  }
  if (rel.startsWith("reports/live-test-runs/")) return "live-test-runs";
  if (rel.startsWith("reports/walkthrough/")) return "walkthrough";
  if (rel.startsWith("reports/")) return "reports";
  return "other";
}

export async function analyzeImageFile(filePath, sharp) {
  void sharp;
  return analyzeSharedImageFile(filePath);
}

export function summarizeTextPreview(text, maxLength = 1200) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .slice(0, maxLength);
}
