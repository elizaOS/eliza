#!/usr/bin/env node
/**
 * One-shot probe for local Eliza desktop dev (Vite/UI port + API port).
 *
 * **Why this exists:** `GET /api/dev/stack` alone requires a running API; this script also checks
 * TCP listeners and merges health/status so CI and agents get one exit code and one JSON blob.
 *
 * For Cursor agents and humans verifying `bun run dev:desktop` / `dev:desktop:watch`.
 *
 * Usage:
 *   node eliza/packages/app-core/scripts/desktop-stack-status.mjs
 *   node eliza/packages/app-core/scripts/desktop-stack-status.mjs --json
 */

import { gatherDesktopStackStatus } from "./lib/desktop-stack-status.mjs";

const json = process.argv.includes("--json");

const report = await gatherDesktopStackStatus();

if (json) {
  console.log(JSON.stringify(report, null, 2));
  const apiReady = report.apiListening && report.apiHealth.ok;
  process.exit(apiReady ? 0 : 1);
}

const {
  uiPort,
  apiPort,
  uiListening,
  apiListening,
  devStack,
  apiHealth,
  apiStatus,
} = report;

console.log(`[desktop-stack-status] UI  ${uiPort}  listening=${uiListening}`);
console.log(`[desktop-stack-status] API ${apiPort}  listening=${apiListening}`);
if (
  devStack &&
  typeof devStack.desktop?.rendererUrl === "string" &&
  devStack.desktop.rendererUrl
) {
  console.log(
    `[desktop-stack-status] GET /api/dev/stack  renderer=${devStack.desktop.rendererUrl}`,
  );
}

if (apiHealth.ok) {
  console.log(
    `[desktop-stack-status] GET /api/health  HTTP ${apiHealth.status}`,
  );
} else {
  console.log(
    `[desktop-stack-status] GET /api/health  FAIL ${apiHealth.status || ""} ${apiHealth.error ?? apiHealth.bodyPreview ?? ""}`,
  );
}

if (
  apiStatus.ok &&
  apiStatus.json &&
  typeof apiStatus.json.state === "string"
) {
  console.log(
    `[desktop-stack-status] GET /api/status state=${apiStatus.json.state}`,
  );
} else if (apiListening) {
  console.log(
    `[desktop-stack-status] GET /api/status  HTTP ${apiStatus.status} ${apiStatus.error ?? ""}`,
  );
}

if (!uiListening && !apiListening) {
  console.log(
    "\n[desktop-stack-status] Nothing listening — start the stack from repo root:\n  bun run dev:desktop\n  bun run dev:desktop:watch\n",
  );
  process.exit(1);
}

process.exit(0);
