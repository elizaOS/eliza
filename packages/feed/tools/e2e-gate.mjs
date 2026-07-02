#!/usr/bin/env node
/**
 * Gate runner for the Feed browser e2e lanes (tools/e2e, tools/chroma).
 *
 * The old inline `sh -c ... exit 0` gate made a skipped lane
 * indistinguishable from a green run. This runner makes skipping VISIBLE:
 *
 * - RUN_FEED_E2E=1  → run the wrapped Playwright command, propagate its exit.
 * - otherwise       → print a loud skip banner + a machine-readable
 *                     `FEED_E2E_RESULT=skipped` line, and exit 0 locally but
 *                     exit 3 (distinct "skipped-but-required" code) when CI
 *                     or FEED_E2E_STRICT=1 is set, so CI can never read a
 *                     skipped lane as a pass.
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const sep = args.indexOf("--");
if (sep === -1 || sep === args.length - 1) {
  console.error(
    "usage: e2e-gate.mjs --suite <name> [--requires <text>] -- <command...>",
  );
  process.exit(2);
}
const opts = args.slice(0, sep);
const command = args.slice(sep + 1);

function opt(name) {
  const i = opts.indexOf(name);
  return i === -1 ? "" : (opts[i + 1] ?? "");
}
const suite = opt("--suite") || "feed-e2e";
const requires = opt("--requires");

if (process.env.RUN_FEED_E2E === "1") {
  const result = spawnSync(command[0], command.slice(1), { stdio: "inherit" });
  process.exit(result.status ?? 1);
}

const strict =
  process.env.FEED_E2E_STRICT === "1" ||
  process.env.CI === "true" ||
  process.env.CI === "1";
const exitCode = strict ? 3 : 0;

const banner = [
  "=".repeat(72),
  `[feed-e2e] SKIPPED (not a pass): ${suite}`,
  "[feed-e2e] This browser e2e lane did NOT run.",
  requires ? `[feed-e2e] Requires: ${requires}` : "",
  "[feed-e2e] Run it with: RUN_FEED_E2E=1 bun run test",
  `FEED_E2E_RESULT=skipped suite=${suite} strict=${strict ? "1" : "0"} exit=${exitCode}`,
  "=".repeat(72),
].filter(Boolean);
console.error(banner.join("\n"));

if (process.env.GITHUB_ACTIONS === "true") {
  console.log(
    `::warning title=${suite} skipped::RUN_FEED_E2E!=1 — browser e2e lane did not run (exit ${exitCode})`,
  );
}
process.exit(exitCode);
