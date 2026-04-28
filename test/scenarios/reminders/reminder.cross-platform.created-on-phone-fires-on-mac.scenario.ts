import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "reminder.cross-platform.created-on-phone-fires-on-mac",
  title: "Reminder created from phone uses the standard reminder pipeline",
  domain: "reminders",
  tags: ["reminders", "lifeops", "cross-platform", "phone-origin"],
  description:
    "A reminder created from the phone channel should be accepted and persisted through the standard reminder pipeline. Cross-device delivery fan-out is covered by the deterministic reminder ladder scenarios.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "phone",
      source: "telegram",
      title: "Reminders Cross-Platform Phone Origin",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-from-phone",
      room: "phone",
      text: "Please set a reminder for 2 hours from now to refill my prescription.",
      responseIncludesAny: ["2 hour", "refill", "prescription"],
    },
    {
      kind: "message",
      name: "confirm-phone-reminder",
      room: "phone",
      text: "Yes, save that reminder.",
      responseIncludesAny: ["saved", "refill", "prescription"],
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "LIFE",
      minCount: 2,
    },
    {
      type: "custom",
      name: "phone-reminder-created",
      predicate: async (ctx) => {
        const finalized = [...ctx.actionsCalled]
          .reverse()
          .find((entry) => entry.actionName === "LIFE");
        const data =
          finalized?.result?.data && typeof finalized.result.data === "object"
            ? (finalized.result.data as {
                definition?: {
                  title?: string;
                  cadence?: { kind?: string; everyMinutes?: number };
                };
                reminderPlan?: {
                  steps?: Array<{ channel?: string; label?: string }>;
                };
              })
            : null;
        if (!data?.definition) {
          return "expected final LIFE action to create a reminder definition";
        }
        if (data.definition.title !== "Refill prescription") {
          return `expected reminder title Refill prescription, got ${data.definition.title ?? "(missing)"}`;
        }
        if (data.definition.cadence?.kind !== "interval") {
          return `expected interval cadence after confirmation, got ${data.definition.cadence?.kind ?? "(missing)"}`;
        }
        if (data.definition.cadence.everyMinutes !== 120) {
          return `expected everyMinutes=120, got ${data.definition.cadence.everyMinutes ?? "(missing)"}`;
        }
        const firstStep = data.reminderPlan?.steps?.[0];
        if (firstStep?.channel !== "in_app") {
          return `expected in_app reminder step, got ${firstStep?.channel ?? "(missing)"}`;
        }
        return undefined;
      },
    },
  ],
});
