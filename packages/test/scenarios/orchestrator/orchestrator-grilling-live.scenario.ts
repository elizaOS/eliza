/** Exposes live completion-verifier behavior to the repository's nightly scenario catalog. */
import type { IAgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { runGrillingHappyPathCheck } from "../../../../plugins/plugin-agent-orchestrator/test/scenarios/_helpers/grilling-scenario.ts";

export default scenario({
  lane: "live-only",
  id: "orchestrator.grilling-happy-path",
  title: "Evidence-free completion is grilled before live-model verification",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "verification", "live"],
  description:
    "Runs the real completion verification loop against a live model: reject an evidence-free claim, then accept pasted passing proof.",
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "live-completion-grilling",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as IAgentRuntime;
        const result = await runGrillingHappyPathCheck(
          runtime,
          (...args: unknown[]) =>
            runtime.useModel(...(args as Parameters<typeof runtime.useModel>)),
        );
        if (result.failure) return result.failure;
        if (result.finalStatus !== "done") {
          return `expected done after verified proof, received ${result.finalStatus}`;
        }
        return undefined;
      },
    },
  ],
});
