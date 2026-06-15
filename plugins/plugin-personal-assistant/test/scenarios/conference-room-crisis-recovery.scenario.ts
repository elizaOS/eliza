import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "conference-room-crisis-recovery",
  title: "Assistant recovers conference room crisis logistics",
  domain: "executive.schedule",
  tags: ["lifeops", "executive-assistant", "schedule", "vendor", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Conference Room Crisis Recovery",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-room-failure",
      text: "The investor meeting room lost AV. Find backup room options, catering impact, dial-in fallback, attendee notification list, and facilities escalation.",
      plannerIncludesAny: ["calendar_action", "owner_send_message", "priority"],
      responseIncludesAny: ["backup room", "catering", "dial-in", "facilities"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-room-update",
      text: "Draft the attendee update and facilities escalation, but ask me before moving the meeting or changing catering.",
      plannerIncludesAny: ["owner_send_message", "approval", "SCHEDULED_TASKS"],
      responseIncludesAny: ["attendee", "facilities", "moving", "catering"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
