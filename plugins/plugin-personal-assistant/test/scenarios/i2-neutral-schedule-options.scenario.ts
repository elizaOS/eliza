/**
 * I2 structural separation plan. The assistant converts a disagreement into
 * neutral schedule options and never decides who deserves the better slot.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "i2.mediation.neutral_schedule_options",
  title: "I2 disagreement becomes neutral schedule separation options",
  domain: "lifeops.relationships",
  tags: ["lifeops", "I2", "mediation", "calendar", "neutral-logistics"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "action",
      name: "create-separated-slots",
      room: "main",
      actionName: "CALENDAR",
      text: "Create two neutral setup windows so Mira and Talia do not need to overlap at the volunteer table.",
      options: {
        action: "create_event",
        title: "Volunteer table separated setup windows",
        calendarId: "cal_personal",
        start: "2026-07-10T17:00:00.000Z",
        end: "2026-07-10T19:00:00.000Z",
        attendees: ["Mira Chen", "Talia Reed"],
        description:
          "Neutral logistics: Mira 17:00-17:45, Talia 18:00-18:45; no fault attribution.",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "CALENDAR",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "CALENDAR",
      includesAll: ["separated setup windows", "Mira", "Talia"],
    },
  ],
});
