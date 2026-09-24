#!/usr/bin/env node
/** Uses the application checkout's canonical contribution evidence gate for OS release recovery PRs. */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isMainModule } from "./distro-android/is-main.mjs";
import { resolveElizaSourceRoot } from "./eliza-source.mjs";

const checker = path.join(
  resolveElizaSourceRoot(),
  "packages/scripts/check-pr-evidence.mjs",
);
export const { evaluatePrEvidence, REQUIRED_EVIDENCE_ROWS } = await import(
  pathToFileURL(checker).href
);

if (isMainModule(import.meta)) {
  const result = spawnSync(
    process.execPath,
    [checker, ...process.argv.slice(2)],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.signal)
    throw new Error(
      `Contribution evidence gate terminated by ${result.signal}.`,
    );
  process.exitCode = result.status;
}
