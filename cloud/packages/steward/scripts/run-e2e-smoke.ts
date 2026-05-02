#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const skipRequested = process.env.ELIZA_SKIP_STEWARD_FI_LIVE_SMOKE?.trim() === "1";
const stewardUrl = process.env.STEWARD_URL?.trim() || "https://api.steward.fi";
const authSmokeScript = new URL("./e2e-auth-test.ts", import.meta.url);

if (skipRequested) {
  console.log("[steward-fi] Skipping e2e smoke because ELIZA_SKIP_STEWARD_FI_LIVE_SMOKE=1.");
  process.exit(0);
}

if (!existsSync(authSmokeScript)) {
  console.log(
    "[steward-fi] Skipping e2e smoke because the auth smoke script is not available in this checkout.",
  );
  process.exit(0);
}

const result = spawnSync("bun", ["run", "scripts/e2e-auth-test.ts"], {
  cwd: process.cwd(),
  stdio: "inherit",
  env: {
    ...process.env,
    STEWARD_URL: stewardUrl,
  },
});

if (result.error?.code === "ENOENT") {
  console.log(
    `[steward-fi] Skipping e2e smoke because the test runner could not be launched: ${result.error.message}`,
  );
  process.exit(0);
}

process.exit(result.status ?? 1);
