/**
 * Runs caller-supplied VFS grep expressions outside the agent event loop.
 * JavaScript regular-expression evaluation is synchronous, so the worker is
 * terminated when a search exceeds its fixed CPU-time budget.
 */
import { Worker } from "node:worker_threads";

/** Longest grep/rg pattern accepted before worker startup. */
export const MAX_VFS_SEARCH_PATTERN_LENGTH = 512;

/** Wall-clock budget for compiling and evaluating one VFS search. */
export const VFS_SEARCH_PATTERN_TIMEOUT_MS = 1_000;

export type VfsSearchPatternResult =
  | { ok: true; selectedLineIndexes: number[][] }
  | { ok: false; error: string };

const WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");

try {
  const matcher = new RegExp(workerData.pattern, workerData.ignoreCase ? "i" : "");
  const selectedLineIndexes = workerData.linesByTarget.map((lines) => {
    const selected = [];
    for (let index = 0; index < lines.length; index += 1) {
      matcher.lastIndex = 0;
      const matches = matcher.test(lines[index]);
      if (workerData.invertMatch ? !matches : matches) {
        selected.push(index);
        if (workerData.filesWithMatches) break;
      }
    }
    return selected;
  });
  parentPort.postMessage({ ok: true, selectedLineIndexes });
} catch (error) {
  parentPort.postMessage({
    ok: false,
    error: error instanceof Error ? error.message : String(error),
  });
}
`;

/**
 * Compile and evaluate a VFS grep pattern in a disposable worker. This keeps
 * full JavaScript RegExp compatibility while making catastrophic backtracking
 * terminate without blocking the agent process.
 */
export function runVfsSearchPattern(options: {
  pattern: string;
  ignoreCase: boolean;
  invertMatch: boolean;
  filesWithMatches: boolean;
  linesByTarget: string[][];
  timeoutMs?: number;
}): Promise<VfsSearchPatternResult> {
  if (options.pattern.length > MAX_VFS_SEARCH_PATTERN_LENGTH) {
    return Promise.resolve({
      ok: false,
      error: `pattern longer than ${MAX_VFS_SEARCH_PATTERN_LENGTH} characters`,
    });
  }

  let worker: Worker;
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      name: "eliza-vfs-regex",
      resourceLimits: { maxOldGenerationSizeMb: 64 },
      workerData: {
        pattern: options.pattern,
        ignoreCase: options.ignoreCase,
        invertMatch: options.invertMatch,
        filesWithMatches: options.filesWithMatches,
        linesByTarget: options.linesByTarget,
      },
    });
  } catch (error) {
    return Promise.resolve({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    const settle = (result: VfsSearchPatternResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };
    const timeoutMs = options.timeoutMs ?? VFS_SEARCH_PATTERN_TIMEOUT_MS;
    const timeoutId = setTimeout(() => {
      timedOut = true;
      void worker.terminate().then(
        () => settle({ ok: false, error: "regular expression timed out" }),
        (error: unknown) =>
          settle({
            ok: false,
            error: `regular expression timed out; worker termination failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
      );
    }, timeoutMs);

    worker.once("message", (result: VfsSearchPatternResult) => settle(result));
    worker.once("error", (error) =>
      settle({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    worker.once("exit", (code) => {
      if (timedOut) {
        settle({ ok: false, error: "regular expression timed out" });
        return;
      }
      if (!settled && code !== 0) {
        settle({
          ok: false,
          error: `regular expression worker exited with code ${code}`,
        });
      }
    });
  });
}
