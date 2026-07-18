/**
 * Curated memory hooks into validation, workspace binding, completion, and
 * respawn prompt assembly. Re-run the existing lifecycle contracts together so
 * changed-file coverage exercises the full OrchestratorTaskService integration
 * surface, rather than only the standalone memory parser.
 */

// The explicit vitest import is LOAD-BEARING: the coverage-gate classifier
// routes changed test files by `from "vitest"` grep, and side-effect imports
// alone would classify this composite into the bun lane — where the imported
// suites' `vi.waitFor`/module mocks are undefined and every case errors.
import { describe, expect, it, vi } from "vitest";
import "./admission-integration.test.js";
// Completion verification: envelope gate + the #16523 claimed-file ledger
// cross-check both live on the same autoVerifyCompletion path this composite
// exists to exercise end to end.
import "./auto-goal-verify.test.js";
import "./built-apps-registry.test.js";
import "./concurrency-lifecycle-integration.test.js";
import "./orchestrator-widget-routes.test.js";
import "./parent-agent-broker-spawn.test.js";
import "./reflexion-respawn.test.js";
import "./sub-agent-completion-verification-framing.test.js";
import "./task-workdir-binding.test.js";

describe("composite lane runner contract", () => {
  it("runs under vitest — the APIs the imported suites depend on exist", () => {
    expect(typeof vi.waitFor).toBe("function");
    expect(typeof vi.mock).toBe("function");
  });
});
