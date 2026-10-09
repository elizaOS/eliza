/**
 * Audits emitted and packaged Android Cloud text without rewriting its bytes.
 * The pinned Coinbase analytics payload only observes worker status and forwards
 * analytics to an existing controller. Its complete literal is recognized by
 * digest; modified payloads and every other worker reference remain findings.
 */
import { createHash } from "node:crypto";
import ts from "typescript";

export const ANDROID_CLOUD_ROUTING_MARKERS = Object.freeze([
  "32437",
  "32438",
  "10.0.2.2",
  "adb reverse",
  "__ELIZA_ANDROID_IPC_FETCH_BRIDGE__",
  "navigator.serviceWorker",
]);

// @coinbase/wallet-sdk 4.3.6: dist/core/telemetry/telemetry-content.js.
// This digest covers the entire decoded 83,300-byte script, not a matching
// fragment, package name, or bundle filename. Dependency changes fail closed.
const COINBASE_ANALYTICS_SHA256 =
  "373bcdaea9398c1f586404f0a39045e09a11949d361ec9c58a46ca5e010f75a4";
const WORKER_MARKER = "navigator.serviceWorker";

function auditedAnalyticsLiteralRanges(content) {
  const source = ts.createSourceFile(
    "android-cloud-asset.js",
    content,
    ts.ScriptTarget.Latest,
    false,
    ts.ScriptKind.JS,
  );
  if (source.parseDiagnostics.length !== 0) return [];
  const ranges = [];
  const visit = (node) => {
    if (
      (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) &&
      node.text.includes(WORKER_MARKER) &&
      createHash("sha256").update(node.text).digest("hex") ===
        COINBASE_ANALYTICS_SHA256
    ) {
      ranges.push([node.getStart(source), node.end]);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return ranges;
}

export function findAndroidCloudRoutingMarkers(content) {
  const lower = content.toLowerCase();
  const present = ANDROID_CLOUD_ROUTING_MARKERS.filter((marker) =>
    lower.includes(marker.toLowerCase()),
  );
  if (!present.includes(WORKER_MARKER)) return present;
  const audited = auditedAnalyticsLiteralRanges(content);
  // Match on the original source: Unicode case conversion can change string
  // length, while parser ranges always use original UTF-16 offsets.
  for (const match of content.matchAll(/navigator\.serviceWorker/gi)) {
    const cursor = match.index;
    if (
      !audited.some(
        ([start, end]) => cursor >= start && cursor + match[0].length <= end,
      )
    ) {
      return present;
    }
  }
  return present.filter((marker) => marker !== WORKER_MARKER);
}
