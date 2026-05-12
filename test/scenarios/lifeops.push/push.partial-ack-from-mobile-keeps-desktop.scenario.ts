import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.partial-ack-from-mobile-keeps-desktop",
  title:
    "Partial 'snooze' ack from mobile defers but keeps the desktop copy alive",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "snooze", "partial-ack"],
  description:
    "User taps 'snooze 10m' on mobile (not 'ack/dismiss'). The desktop copy should remain so the snoozed reminder re-fires on both devices 10m later, not just one.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Partial ack",
    },
    {
      id: "mobile",
      source: "discord",
      channelType: "DM",
      title: "Mobile snooze room",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "snooze-on-mobile",
      room: "mobile",
      text: "Snooze that reminder 10 minutes from my phone — don't fully ack, I still want to see it on desktop later.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "partial snooze, not dismiss",
        includesAny: ["snooze", "10 minutes", "desktop", "still"],
      }),
      responseIncludesAny: ["snooze", "10", "desktop"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must distinguish snooze (defer 10m, re-fire on both devices) from ack (clear everywhere). Treating snooze as ack and clearing desktop fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT"],
    },
    {
      type: "custom",
      name: "push-partial-ack-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT"],
        description: "snooze != ack",
      }),
    },
    judgeRubric({
      name: "push-partial-ack-rubric",
      threshold: 0.7,
      description:
        "Snooze deferred 10m on both surfaces, desktop copy not cleared.",
    }),
  ],
});
