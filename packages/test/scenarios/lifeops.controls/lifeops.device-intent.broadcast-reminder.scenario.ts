import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
} from "../_helpers/action-assertions.ts";

/**
 * Closes the gap from the lifeops audit (`docs/audits/lifeops-2026-05-09/
 * 03-coverage-gap-matrix.md` line 441): `deviceIntentAction` had no scenario.
 *
 * Asserts the planner routes "broadcast a reminder to my phone" to
 * DEVICE_INTENT with target=mobile. The action result carries the persisted
 * intent record (kind, target, title) so we can prove the broadcast actually
 * reached the underlying intent-sync surface.
 */
export default scenario({
  id: "lifeops.device-intent.broadcast-reminder",
  title: "User asks to broadcast a reminder → DEVICE_INTENT routes to mobile",
  domain: "lifeops",
  tags: ["lifeops", "device-intent", "cross-device", "controls"],
  description:
    "When the owner asks the agent to send a phone reminder, the planner should call DEVICE_INTENT with target=mobile. The action result must include the persisted intent's kind and target.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "LifeOps Device Intent Broadcast",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request-mobile-broadcast",
      room: "main",
      text: "Broadcast a reminder to my phone titled 'Stretch' saying 'Take a 60-second break.'",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "device intent broadcast to mobile",
      }),
      responseIncludesAny: ["broadcast", "phone", "mobile", "Stretch"],
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: "DEVICE_INTENT",
    },
    {
      type: "custom",
      name: "device-intent-action-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "DEVICE_INTENT broadcast invoked",
      }),
    },
    {
      type: "custom",
      name: "device-intent-targets-mobile",
      predicate: async (ctx) => {
        const hit = ctx.actionsCalled.find(
          (action) => action.actionName === "DEVICE_INTENT",
        );
        if (!hit) return "expected DEVICE_INTENT action result";
        const data = hit.result?.data as
          | {
              intent?: {
                kind?: string;
                target?: string;
                title?: string;
              };
            }
          | undefined;
        if (!data?.intent) return "expected DEVICE_INTENT to return intent";
        if (data.intent.target !== "mobile") {
          return `expected target=mobile, got ${String(data.intent.target)}`;
        }
        if (
          typeof data.intent.title !== "string" ||
          data.intent.title.length === 0
        ) {
          return "expected DEVICE_INTENT result.intent.title to be set";
        }
        return undefined;
      },
    },
  ],
});
