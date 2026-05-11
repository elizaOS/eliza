import { scenario } from "@elizaos/scenario-schema";
import {
  expectScenarioToCallAction,
  expectStateTransition,
  expectTurnToCallAction,
  judgeRubric,
} from "../_helpers/action-assertions.ts";

export default scenario({
  id: "push.scheduled-notification-cancel-when-event-cancelled",
  title: "Cancelling a calendar event also cancels its pending push ladder",
  domain: "lifeops.push",
  tags: ["lifeops", "push", "cancel", "calendar", "rollback"],
  description:
    "T-1h / T-10m / T-0 reminders were scheduled for an event. The event got cancelled. Agent must tear down the pending ladder — not let reminders fire for a meeting that no longer exists.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "Cancel scheduled push",
    },
  ],
  seed: [
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "calendar-event",
        id: "evt-investor-sync",
        title: "Investor sync",
        startAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString(),
        cancelled: true,
        cancelledAt: new Date().toISOString(),
      },
    },
    {
      type: "memory",
      roomId: "main",
      content: {
        kind: "scheduled-push-ladder",
        eventId: "evt-investor-sync",
        rungs: [
          { offsetMin: -60, channel: "desktop", status: "pending" },
          { offsetMin: -10, channel: "mobile", status: "pending" },
          { offsetMin: 0, channel: "mobile", status: "pending" },
        ],
      },
    },
  ],
  turns: [
    {
      kind: "message",
      name: "cancel-scheduled-push",
      room: "main",
      text: "The investor sync got cancelled. Tear down the reminder ladder so I don't get pinged.",
      assertTurn: expectTurnToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "tear down ladder after event cancel",
        includesAny: ["cancel", "tear down", "remove", "ladder", "investor"],
      }),
      responseIncludesAny: ["cancel", "investor", "removed", "torn down"],
      responseJudge: {
        minimumScore: 0.7,
        rubric:
          "Reply must confirm all three rungs are cancelled. Leaving any pending fails.",
      },
    },
  ],
  finalChecks: [
    {
      type: "selectedAction",
      actionName: ["DEVICE_INTENT", "CALENDAR"],
    },
    {
      type: "custom",
      name: "push-cancel-ladder-coverage",
      predicate: expectScenarioToCallAction({
        acceptedActions: ["DEVICE_INTENT", "CALENDAR"],
        description: "tear down scheduled pushes",
      }),
    },
    {
      type: "custom",
      name: "push-cancel-ladder-state",
      predicate: expectStateTransition({
        subject: "deviceIntent",
        to: "cancelled",
        description: "scheduled push transitions to cancelled when its event is cancelled",
      }),
    },
    judgeRubric({
      name: "push-cancel-ladder-rubric",
      threshold: 0.7,
      description:
        "All three pending rungs cancelled after event cancellation — no zombie pings.",
    }),
  ],
});
