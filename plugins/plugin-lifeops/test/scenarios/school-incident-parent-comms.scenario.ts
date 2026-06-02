import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "school-incident-parent-comms",
  title: "Assistant handles school incident communications across parent and work calendars",
  domain: "executive.family",
  tags: ["lifeops", "executive-assistant", "calendar", "messaging"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps School Incident Parent Comms",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-school-incident",
      text: "The school called about an incident. Check my afternoon calendar, draft a note to the teacher, a short message to the other parent, and a work reschedule only if the parent meeting conflicts.",
      plannerIncludesAny: ["calendar_action", "owner_send_message", "conflict"],
      responseIncludesAny: ["school", "teacher", "parent", "calendar"],
      plannerExcludes: ["OWNER_FINANCES"],
    },
    {
      kind: "message",
      name: "approval-gate-sensitive-note",
      text: "Keep the work note neutral and do not include the child's details. Ask me before anything is sent.",
      plannerIncludesAny: ["privacy", "approval", "draft"],
      responseIncludesAny: ["neutral", "approval", "details", "draft"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
