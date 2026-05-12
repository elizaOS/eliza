import { scenario } from "@elizaos/scenario-schema";
import { setScreenContextSamplerForTesting } from "../../../plugins/app-lifeops/src/activity-profile/service.ts";
import {
  LifeOpsScreenContextSampler,
  type LifeOpsScreenContextSummary,
} from "../../../plugins/app-lifeops/src/lifeops/screen-context.ts";

class FixedScreenContextSampler extends LifeOpsScreenContextSampler {
  override async sample(
    nowMs = Date.now(),
  ): Promise<LifeOpsScreenContextSummary> {
    return {
      sampledAtMs: nowMs,
      source: "vision",
      available: true,
      throttled: false,
      stale: false,
      busy: true,
      framePath: "scenario://activity-context",
      capturedAtMs: nowMs,
      width: 1440,
      height: 900,
      byteLength: 1,
      averageLuma: 0.42,
      lumaStdDev: 0.11,
      ocrAvailable: true,
      ocrText: "Slack docs terminal calendar",
      focus: "work",
      contextTags: ["work", "screen-active", "text-heavy"],
      cues: ["slack", "docs", "terminal", "calendar"],
      confidence: 0.96,
      disabledReason: null,
    };
  }
}

export default scenario({
  id: "activity.context-aware-response",
  title: "Agent references current app context",
  domain: "activity",
  tags: ["activity", "context", "happy-path"],
  description:
    "User asks a question that benefits from knowing the current screen focus; the agent references the seeded focus context.",

  status: "pending",

  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },

  seed: [
    {
      type: "custom",
      name: "seed-current-screen-context",
      apply: async () => {
        setScreenContextSamplerForTesting(new FixedScreenContextSampler());
        return undefined;
      },
    },
  ],

  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Activity: context-aware",
    },
  ],

  turns: [
    {
      kind: "message",
      name: "context-aware-query",
      room: "main",
      text: "What am I working on right now?",
      responseIncludesAny: [/work/i, /focus/i, /screen/i, /slack/i],
    },
  ],

  finalChecks: [
    {
      type: "custom",
      name: "context-aware-response-uses-current-focus",
      predicate: async (ctx) => {
        try {
          const reply = String(ctx.turns?.[0]?.responseText ?? "");
          if (!reply.trim()) {
            return "expected a response text from the context-aware turn";
          }
          if (!/work|focus|screen|slack/i.test(reply)) {
            return `expected the reply to reference the seeded screen context; got: ${reply}`;
          }
          return undefined;
        } finally {
          setScreenContextSamplerForTesting(null);
        }
      },
    },
  ],
});
