/**
 * Live-model evidence for origin-channel interruption classification, paired
 * with the deterministic forwarding scenario that exercises delivery wiring.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { IAgentRuntime, ModelTypeName } from "@elizaos/core";
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
        const modelIo: Array<{
          modelType: ModelTypeName;
          prompt: string;
          response: string;
        }> = [];
        const observedRuntime = new Proxy(runtime, {
          get(target, property, receiver) {
            if (property !== "useModel") {
              return Reflect.get(target, property, receiver);
            }
            return async (
              modelType: ModelTypeName,
              params: { prompt?: unknown },
            ) => {
              const response = await runtime.useModel(modelType, params);
              modelIo.push({
                modelType,
                prompt: typeof params.prompt === "string" ? params.prompt : "",
                response:
                  typeof response === "string" ? response : String(response),
              });
              return response;
            };
          },
        }) as IAgentRuntime;
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

        let failure: string | undefined;
        for (const example of cases) {
          const decision = await decideInterruptionWithModel(observedRuntime, {
            text: example.text,
            agentType: "codex",
            agentLabel: "Ada",
            sessionBusy: example.sessionBusy,
            sharedChannel: true,
            taskContext:
              "Refactor authentication session refresh and add regression coverage",
          });
          if (decision.action !== example.expected) {
            failure = `${JSON.stringify(example.text)} expected ${example.expected}, received ${decision.action}: ${decision.reason}`;
            break;
          }
          if (!decision.reason.startsWith("model:")) {
            failure = `${JSON.stringify(example.text)} used the fallback instead of the live model: ${decision.reason}`;
            break;
          }
        }
        const runDir = process.env.ELIZA_LIFEOPS_RUN_DIR?.trim();
        if (!runDir) {
          return "the scenario runner did not expose its run directory";
        }
        await mkdir(runDir, { recursive: true });
        await writeFile(
          path.join(runDir, "orchestrator-routing-model-io.jsonl"),
          `${modelIo.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
          "utf8",
        );
        return failure;
      },
    },
  ],
});
