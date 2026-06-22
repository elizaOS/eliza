import type { IAgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { runGrillingEvidenceBundleCheck } from "./_helpers/grilling-scenario.ts";

// Grilling evidence bundle (#8932): the verifier must judge TYPED evidence, not
// the bare event summary. The sub-agent's completion carries a git diff and the
// test stdout; this asserts both actually reach the verifier's prompt. Uses a
// capturing model (no live judgement needed), so it runs in the keyless
// `pr-deterministic` lane. Shared logic is verified by
// `orchestrator-scenario-logic.test.ts`.
export default scenario({
  lane: "pr-deterministic",
  id: "orchestrator.grilling-evidence-bundle",
  title: "Grilling: the git diff + test stdout reach the verifier",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "grilling", "evidence", "deterministic"],
  description:
    "A sub-agent reports complete with a git diff and pasted test stdout. Asserts the OrchestratorTaskService assembles that evidence and passes both the diff and the test output through to the verifier prompt (the verifier judges typed evidence, not the event summary).",
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "grilling-evidence-bundle",
      predicate: (ctx) =>
        runGrillingEvidenceBundleCheck(ctx.runtime as IAgentRuntime),
    },
  ],
});
