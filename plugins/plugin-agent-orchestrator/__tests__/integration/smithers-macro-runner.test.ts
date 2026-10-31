/**
 * Real Smithers macro worker: the parent writes each phase response to the
 * worker's stdin, and the worker reads it line by line with readline.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  runSmithersObservabilityMacro,
  SMITHERS_MACRO_PHASES,
} from "../../src/services/smithers-macro-runner.js";

describe("Smithers macro runner", () => {
  it("bridges phase evidence that contains Unicode line and paragraph separators", async () => {
    // Evidence summaries quote issue bodies, commit messages and CI logs, any
    // of which can carry U+2028/U+2029.
    const summary = "Observed\u2028issue body\u2029and CI log";
    const rootDir = await mkdtemp(join(tmpdir(), "smithers-macro-"));
    try {
      const result = await runSmithersObservabilityMacro(
        {
          runId: `separators-${Date.now()}`,
          elizaTaskId: "task-separators",
          repository: "elizaOS/eliza",
          issueNumber: 1,
          rootDir,
        },
        {
          observePhase: async (phase) => ({ summary: `${phase}: ${summary}` }),
        },
      );

      expect(result.status).toBe("completed");
      expect(result.phases.map((frame) => frame.phase)).toEqual([
        ...SMITHERS_MACRO_PHASES,
      ]);
      expect(result.phases.map((frame) => frame.evidence.summary)).toEqual(
        SMITHERS_MACRO_PHASES.map((phase) => `${phase}: ${summary}`),
      );
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  }, 60_000);
});
