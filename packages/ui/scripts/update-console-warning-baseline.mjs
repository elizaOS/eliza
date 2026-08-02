/**
 * Captures current per-test console warnings so the unit suite can reject new
 * warning fingerprints and count increases while legacy noise is paid down.
 */

import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageRoot = resolve(import.meta.dirname, "..");
const captureDirectory = mkdtempSync(join(tmpdir(), "eliza-ui-console-"));
const capturePrefix = join(captureDirectory, "warnings");
const result = spawnSync(
  "bunx",
  ["vitest", "run", "--config", "./vitest.config.ts", "--reporter=dot"],
  {
    cwd: packageRoot,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
      UPDATE_TEST_CONSOLE_BASELINE: capturePrefix,
    },
    stdio: "inherit",
  },
);

const baseline = {};
for (const name of readdirSync(captureDirectory)) {
  if (!name.endsWith(".jsonl")) continue;
  const records = readFileSync(join(captureDirectory, name), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  for (const { messages } of records) {
    const observed = {};
    for (const message of messages) {
      observed[message] = (observed[message] ?? 0) + 1;
    }
    for (const [message, count] of Object.entries(observed)) {
      baseline[message] = Math.max(baseline[message] ?? 0, count);
    }
  }
}

const ordered = Object.fromEntries(
  Object.entries(baseline).sort(([left], [right]) => left.localeCompare(right)),
);
writeFileSync(
  resolve(packageRoot, "test/console-warning-baseline.json"),
  `${JSON.stringify(ordered, null, 2)}\n`,
);
rmSync(captureDirectory, { recursive: true });
console.log(
  `Updated console warning baseline with ${Object.keys(ordered).length} warning fingerprints.`,
);
process.exitCode = result.status ?? 1;
