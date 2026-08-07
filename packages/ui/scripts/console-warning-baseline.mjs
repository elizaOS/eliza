/**
 * Builds the unit-test console-warning ratchet from per-test capture records,
 * and owns the message fingerprint both the ratchet and `vitest.setup.ts` match
 * on — the two must agree byte-for-byte or a baselined message reads as new.
 *
 * Baselines are replaced only after a successful complete suite, because a
 * partial run cannot prove that omitted fingerprints have been eliminated.
 */
import { readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * SGR escapes only; the logger emits no other terminal control sequences. ESC
 * is composed rather than written inline because a control character in a
 * regex literal is itself a lint error (`noControlCharactersInRegex`).
 */
const ANSI_SGR_PATTERN = new RegExp(
  `${String.fromCharCode(27)}\\[[0-9;]*m`,
  "gu",
);

/**
 * Canonical fingerprint for one captured console message.
 *
 * The structured logger colorizes its output whenever its color mode is on,
 * which differs between a contributor's terminal and a CI runner. Those escape
 * bytes landed in the recorded message but never in the committed baseline, so
 * a colorized run reported an already-baselined warning as a fresh regression
 * and failed the owning test over nothing but the runner's color decision.
 */
export function normalizeConsoleMessage(message) {
  return message.replace(ANSI_SGR_PATTERN, "");
}

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
        const fingerprint = normalizeConsoleMessage(message);
        observed[fingerprint] = (observed[fingerprint] ?? 0) + 1;
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
