/**
 * Spawn-counter reader for the `run-node.mjs` supervisor integration test.
 *
 * The fake child writes `spawn-count.txt` on every launch. When the supervisor
 * aborts before spawning, that file is never created and an unguarded read would
 * throw inside an `EventEmitter` callback, leaving the test promise unsettled
 * until vitest's timeout. This helper fails fast and surfaces captured stderr.
 */
import fs from "node:fs";
import path from "node:path";

/**
 * @param {string} counterFile - Absolute path to the fake child's spawn counter.
 * @param {{ code: number | null, stderr: string }} context - Supervisor exit metadata.
 * @returns {number} Parsed spawn count from the counter file.
 */
export function readSpawnCountForSupervisorTest(counterFile, { code, stderr }) {
  try {
    return Number(fs.readFileSync(counterFile, "utf8").trim() || "0");
  } catch (error) {
    const errCode =
      error && typeof error === "object" && "code" in error
        ? error.code
        : "unknown";
    throw new Error(
      `supervisor exited with code ${code} without spawning the child ` +
        `(${path.basename(counterFile)} was never written: ${errCode}).\n` +
        `--- supervisor stderr ---\n${stderr || "(empty)"}`,
    );
  }
}
