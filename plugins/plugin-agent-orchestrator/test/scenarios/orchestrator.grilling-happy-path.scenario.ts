/**
 * Live-model scenario for the OrchestratorTaskService grilling loop (#8932): a
 * sub-agent's evidence-free "done" is grilled and rejected, then verified once
 * it re-reports with pasted passing test output. The verifier judgement runs
 * against the scenario's live model, so this is the `live-only` lane; the same
 * loop is asserted deterministically in `orchestrator-scenario-logic` for CI.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { runGrillingHappyPathCheck } from "./_helpers/grilling-scenario";

let capturedRuntime: IAgentRuntime | undefined;

// Grilling happy path (#8932): a sub-agent claims done with NO test output →
// the verifier grills (corrective re-prompt citing the unmet criterion) → the
// sub-agent re-reports WITH pasted passing test output → the task is verified
// done. The verifier runs against the scenario's LIVE model (the judgement is
// what's under test), so this is the `live-only` lane. The same loop is asserted
// deterministically in `orchestrator-scenario-logic.test.ts` for keyless CI.
export default scenario({
  lane: "live-only",
  id: "orchestrator.grilling-happy-path",
  title:
    "Grilling: a no-evidence 'done' is grilled, then verified on pasted proof",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "grilling", "verification", "live"],
  description:
    "Drives the OrchestratorTaskService verification loop: round 1 claims complete with no evidence and must be grilled (not accepted); round 2 re-reports with pasted passing test output and is verified done. The verifier judgement uses the live model.",
  seed: [
    {
      type: "custom",
      name: "capture live runtime for verifier",
      apply: async (ctx) => {
        capturedRuntime = ctx.runtime as IAgentRuntime;
        return undefined;
      },
    },
  ],
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "grilling-happy-path",
      predicate: (ctx) => {
        const runtime =
          (ctx.runtime as IAgentRuntime | undefined) ?? capturedRuntime;
        if (!runtime) return "scenario runtime unavailable";
        return runGrillingHappyPathCheck(runtime, (...args: unknown[]) =>
          runtime.useModel(...(args as Parameters<typeof runtime.useModel>)),
        );
      },
    },
  ],
});
