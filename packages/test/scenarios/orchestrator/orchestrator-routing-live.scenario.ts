/**
 * Live-model evidence for origin-channel interruption classification, paired
 * with the deterministic forwarding scenario that exercises delivery wiring.
 */
import type { IAgentRuntime } from "@elizaos/core";
import { scenario } from "@elizaos/scenario-runner/schema";
import { decideInterruptionWithModel } from "../../../../plugins/plugin-agent-orchestrator/src/services/interruption-decider.ts";

export default scenario({
  lane: "live-only",
  id: "orchestrator.origin-routing-live",
  title: "Origin-channel messages are classified for the coding task",
  domain: "agent-orchestrator",
  tags: ["orchestrator", "routing", "live"],
  description:
    "Uses a live model to distinguish planner-owned origin-channel chatter from coding-task follow-ups for idle and busy sub-agents.",
  turns: [],
  finalChecks: [
    {
      type: "custom",
      name: "live-origin-channel-classification",
      predicate: async (ctx) => {
        const runtime = ctx.runtime as IAgentRuntime;
        const cases = [
          {
            text: "Remind me to call Mom at 6pm.",
            sessionBusy: false,
            expected: "ignore",
          },
          {
            text: "For the authentication refactor, also add a regression test for expired sessions.",
            sessionBusy: false,
            expected: "deliver",
          },
          {
            text: "For the authentication refactor, also cover concurrent session refreshes.",
            sessionBusy: true,
            expected: "queue",
          },
        ] as const;

        for (const example of cases) {
          const decision = await decideInterruptionWithModel(runtime, {
            text: example.text,
            agentType: "codex",
            agentLabel: "Ada",
            sessionBusy: example.sessionBusy,
            sharedChannel: true,
            taskContext:
              "Refactor authentication session refresh and add regression coverage",
          });
          if (decision.action !== example.expected) {
            return `${JSON.stringify(example.text)} expected ${example.expected}, received ${decision.action}: ${decision.reason}`;
          }
          if (!decision.reason.startsWith("model:")) {
            return `${JSON.stringify(example.text)} used the fallback instead of the live model: ${decision.reason}`;
          }
        }
        return undefined;
      },
    },
  ],
});
