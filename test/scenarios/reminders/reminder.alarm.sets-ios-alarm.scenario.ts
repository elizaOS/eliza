import { scenario } from "@elizaos/scenario-schema";

export default scenario({
  id: "reminder.alarm.sets-ios-alarm",
  title: "iPhone alarm request lands in an owner scheduling flow",
  domain: "reminders",
  tags: ["reminders", "lifeops", "scheduling"],
  description:
    "An iPhone alarm request currently lands in one of the owner scheduling flows that are available in the environment, typically a life reminder or owner calendar event.",
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "discord",
      title: "Reminders iOS Alarm",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "request ios alarm",
      text: "Set an iOS alarm on my phone for 6:30am tomorrow to catch the flight.",
      responseIncludesAny: ["alarm", "6:30", "iPhone"],
    },
  ],
  finalChecks: [
    {
      type: "custom",
      name: "ios-alarm-routing",
      predicate: async (ctx) => {
        const lifeAction = ctx.actionsCalled.find(
          (entry) => entry.actionName === "LIFE",
        );
        if (
          lifeAction?.result?.data &&
          typeof lifeAction.result.data === "object"
        ) {
          const data = lifeAction.result.data as {
            definition?: {
              cadence?: { kind?: string };
              metadata?: {
                nativeAppleReminder?: { kind?: string; provider?: string };
              };
            };
            reminderPlan?: { id?: string };
          };
          if (!data.definition) {
            return "expected LIFE to return a saved reminder definition";
          }
          if (data.definition.cadence?.kind !== "once") {
            return `expected once cadence, got ${data.definition.cadence?.kind ?? "(missing)"}`;
          }
          if (data.definition.metadata?.nativeAppleReminder?.kind !== "alarm") {
            return "expected Apple reminder metadata with alarm kind";
          }
          if (
            data.definition.metadata?.nativeAppleReminder?.provider !==
            "apple_reminders"
          ) {
            return "expected Apple reminder provider metadata";
          }
          if (
            typeof data.reminderPlan?.id !== "string" ||
            data.reminderPlan.id.length === 0
          ) {
            return "expected LIFE to return a reminder plan id";
          }
          return undefined;
        }

        const calendarAction = ctx.actionsCalled.find(
          (entry) => entry.actionName === "CALENDAR",
        );
        if (
          calendarAction?.result?.data &&
          typeof calendarAction.result.data === "object"
        ) {
          const data = calendarAction.result.data as {
            title?: string;
            status?: string;
            startAt?: string;
          };
          if (data.status !== "confirmed") {
            return `expected confirmed owner calendar event, got ${data.status ?? "(missing)"}`;
          }
          if (typeof data.startAt !== "string" || data.startAt.length === 0) {
            return "expected owner calendar event start time";
          }
          if (
            typeof data.title !== "string" ||
            !/alarm|flight/i.test(data.title)
          ) {
            return `expected owner calendar title to mention the alarm/flight, got ${data.title ?? "(missing)"}`;
          }
          return undefined;
        }
        return `expected iOS alarm request to route through LIFE or CALENDAR. Called: ${ctx.actionsCalled.map((action) => action.actionName).join(",") || "(none)"}`;
      },
    },
  ],
});
