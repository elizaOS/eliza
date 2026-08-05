/**
 * Builds the unit-test console-warning ratchet from per-test capture records.
 * Baselines are replaced only after a successful complete suite, because a
 * partial run cannot prove that omitted fingerprints have been eliminated.
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function collectConsoleWarningBaseline(captureDirectory) {
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

  return Object.fromEntries(
    Object.entries(baseline).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function replaceConsoleWarningBaseline({
  captureDirectory,
  baselinePath,
  runStatus,
}) {
  if (runStatus !== 0) return null;
  const baseline = collectConsoleWarningBaseline(captureDirectory);
  const pendingPath = `${baselinePath}.${process.pid}.tmp`;
  writeFileSync(pendingPath, `${JSON.stringify(baseline, null, 2)}\n`);
  renameSync(pendingPath, baselinePath);
  return Object.keys(baseline).length;
}
