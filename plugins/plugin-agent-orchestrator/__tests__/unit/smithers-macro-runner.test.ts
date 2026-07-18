import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  runSmithersObservabilityMacro,
  SMITHERS_MACRO_PHASES,
  type SmithersMacroPhaseContext,
} from "../../src/services/smithers-macro-runner";

const roots: string[] = [];
const TIMEOUT = 60_000;

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("runSmithersObservabilityMacro", () => {
  it(
    "records the six lifecycle phases with Eliza and trajectory correlation",
    async () => {
      const rootDir = await mkdtemp(join(tmpdir(), "eliza-smithers-macro-"));
      roots.push(rootDir);
      const contexts: SmithersMacroPhaseContext[] = [];
      const result = await runSmithersObservabilityMacro(
        {
          runId: "macro-correlation-test",
          elizaTaskId: "task-16632",
          trajectoryId: "trajectory-16632",
          repository: "elizaOS/eliza",
          issueNumber: 16632,
          rootDir,
        },
        {
          async observePhase(phase, context) {
            contexts.push(context);
            return {
              summary: `observed ${phase}`,
              references: { evidence: `receipt://${phase}` },
            };
          },
        },
      );

      expect(result.status).toBe("completed");
      expect(result.phases.map((entry) => entry.phase)).toEqual(
        SMITHERS_MACRO_PHASES,
      );
      expect(contexts).toHaveLength(SMITHERS_MACRO_PHASES.length);
      for (const context of contexts) {
        expect(context.smithersRunId).toBe("macro-correlation-test");
        expect(context.smithersNodeId).toBeTruthy();
        expect(context.smithersAttempt).toBeGreaterThanOrEqual(1);
        expect(context.elizaTaskId).toBe("task-16632");
        expect(context.trajectoryId).toBe("trajectory-16632");
      }
      expect((await stat(result.databasePath)).size).toBeGreaterThan(0);
      expect(result.watch.monitorCommand).toContain(
        "monitor macro-correlation-test",
      );
      expect(result.watch.inspectCommand).toContain(
        "inspect macro-correlation-test",
      );
      expect(result.watch.replayCommand).toContain(
        "events macro-correlation-test --json",
      );
    },
    TIMEOUT,
  );

  it(
    "resumes a completed run without repeating observed phases",
    async () => {
      const rootDir = await mkdtemp(
        join(tmpdir(), "eliza-smithers-macro-resume-"),
      );
      roots.push(rootDir);
      let calls = 0;
      const spec = {
        runId: "macro-resume-test",
        elizaTaskId: "task-resume",
        repository: "elizaOS/eliza",
        issueNumber: 1,
        rootDir,
      };
      const executor = {
        async observePhase(phase: (typeof SMITHERS_MACRO_PHASES)[number]) {
          calls += 1;
          return { summary: phase };
        },
      };

      await runSmithersObservabilityMacro(spec, executor);
      expect(calls).toBe(6);
      const resumed = await runSmithersObservabilityMacro(spec, executor);
      expect(calls).toBe(6);
      expect(resumed.phases).toEqual([]);

      // The persisted file is a real Smithers store, not an Eliza shadow log.
      const header = await readFile(resumed.databasePath);
      expect(header.subarray(0, 15).toString()).toBe("SQLite format 3");
    },
    TIMEOUT,
  );
});
