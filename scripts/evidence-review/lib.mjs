/**
 * Evidence artifact discovery and screenshot heuristics for the local reviewer.
 * The generator keeps filesystem and HTML output in `generate.mjs`; this module
 * holds the small pure pieces so the dashboard's classification rules have
 * focused tests.
 */

import path from "node:path";

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
  if (rel.startsWith(".github/issue-evidence/")) {
    return "retired-issue-evidence";
  }
  if (rel.startsWith("reports/")) return "reports";
  return "other";
}

function rgbToHex(r, g, b) {
  return `#${[r, g, b]
    .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0"))
    .join("")}`;
}

function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const lightness = (max + min) / 2;
  if (max === min) return { hue: 0, saturation: 0, lightness };
  const delta = max - min;
  const saturation =
    lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let hue;
  if (max === rn) hue = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) hue = (bn - rn) / delta + 2;
  else hue = (rn - gn) / delta + 4;
  return { hue: hue * 60, saturation, lightness };
}

function quantizeChannel(value, step) {
  return Math.max(0, Math.min(255, Math.round(value / step) * step));
}

export async function analyzeImageFile(filePath, sharp) {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .resize({
      width: 120,
      height: 120,
      fit: "inside",
      withoutEnlargement: true,
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const buckets = new Map();
  let bluePixels = 0;
  let orangePixels = 0;
  let redPixels = 0;
  let luminanceTotal = 0;

  for (let i = 0; i < data.length; i += 4) {
    const alpha = data[i + 3] / 255;
    if (alpha < 0.05) continue;

    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const key = [
      quantizeChannel(r, 16),
      quantizeChannel(g, 16),
      quantizeChannel(b, 16),
    ].join(",");
    buckets.set(key, (buckets.get(key) ?? 0) + 1);

    const { hue, saturation, lightness } = rgbToHsl(r, g, b);
    if (saturation > 0.28 && lightness > 0.18 && lightness < 0.86) {
      if (hue >= 190 && hue <= 255) bluePixels += 1;
      if (hue >= 15 && hue <= 45) orangePixels += 1;
      if (hue <= 8 || hue >= 350) redPixels += 1;
    }
    luminanceTotal += 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  const sampledPixels = Math.max(0, info.width * info.height);
  const topBuckets = [...buckets.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([key, count]) => {
      const [r, g, b] = key.split(",").map((n) => Number.parseInt(n, 10));
      return {
        hex: rgbToHex(r, g, b),
        count,
        ratio: sampledPixels === 0 ? 0 : count / sampledPixels,
      };
    });
  const dominantRatio = topBuckets[0]?.ratio ?? 1;
  const averageLuminance =
    sampledPixels === 0 ? 0 : Math.round(luminanceTotal / sampledPixels);
  const issues = [];
  if (sampledPixels === 0) issues.push("screenshot has no sampled pixels");
  if (buckets.size <= 1) issues.push("screenshot is one color");
  if (buckets.size <= 2 && dominantRatio > 0.995) {
    issues.push("screenshot is effectively one color");
  }
  if (
    dominantRatio > 0.992 &&
    (averageLuminance < 8 || averageLuminance > 247)
  ) {
    issues.push("screenshot is near-solid black/white");
  }
  const blueRatio = sampledPixels === 0 ? 0 : bluePixels / sampledPixels;
  if (
    blueRatio > 0.015 &&
    blueRatio > orangePixels / Math.max(1, sampledPixels)
  ) {
    issues.push("blue accent candidate exceeds orange pixels");
  }

  return {
    width: info.width,
    height: info.height,
    sampledPixels,
    colorBuckets: buckets.size,
    dominantRatio,
    dominantColors: topBuckets,
    blueRatio,
    orangeRatio: sampledPixels === 0 ? 0 : orangePixels / sampledPixels,
    redRatio: sampledPixels === 0 ? 0 : redPixels / sampledPixels,
    averageLuminance,
    issues,
  };
}

export function summarizeTextPreview(text, maxLength = 1200) {
  return String(text ?? "")
    .replace(/\r/g, "")
    .replace(ANSI_ESCAPE_PATTERN, "")
    .slice(0, maxLength);
}
