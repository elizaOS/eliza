/**
 * Calendar conflict-detect + reschedule (#8795 item 6). Fills the thin calendar
 * domain: a double-booking is created, CONFLICT_DETECT surfaces the clash, and
 * the owner reschedules the lower-priority event to resolve it.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "calendar-conflict-detect-reschedule",
  title: "Detect a calendar double-booking and reschedule to resolve it",
  domain: "calendar",
  tags: ["lifeops", "calendar", "conflict", "reschedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Calendar Conflict",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "create-first",
      text: "Add a budget review with Priya tomorrow from 2 to 3pm.",
      plannerIncludesAny: ["calendar_action", "create_event", "priya"],
      plannerExcludes: ["gmail_action", "owner_send_message"],
    },
    {
      kind: "message",
      name: "create-overlap",
      text: "Also book a dentist appointment tomorrow at 2:30pm for 45 minutes.",
      plannerIncludesAny: ["calendar_action", "create_event", "dentist"],
      plannerExcludes: ["gmail_action"],
    },
    {
      kind: "message",
      name: "detect-conflict",
      text: "Do I have any scheduling conflicts tomorrow afternoon?",
      plannerIncludesAny: ["CONFLICT_DETECT", "conflict", "calendar_action"],
      responseIncludesAny: ["conflict", "overlap", "budget", "dentist", "2"],
      plannerExcludes: ["gmail_action"],
    },
    {
      kind: "message",
      name: "reschedule-resolve",
      text: "Move the dentist appointment to 4pm so it doesn't clash.",
      plannerIncludesAny: ["calendar_action", "update_event", "dentist", "4"],
      responseIncludesAny: ["dentist", "4", "moved", "reschedul"],
      plannerExcludes: ["gmail_action"],
    },
  ],
});
