import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "visa-renewal-travel-blocker",
  title: "Assistant turns a visa renewal issue into a travel blocker plan",
  domain: "executive.travel",
  tags: ["lifeops", "executive-assistant", "travel", "documents", "schedule"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Visa Renewal Travel Blocker",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "detect-visa-travel-risk",
      text: "Check whether the Singapore trip is blocked by my visa renewal timing. Compare travel dates, passport validity, consulate appointment slots, and flight cancellation deadlines.",
      plannerIncludesAny: ["calendar_action", "OWNER_DOCUMENTS", "travel"],
      responseIncludesAny: ["visa", "passport", "appointment", "deadline"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "stage-travel-risk-response",
      text: "Prepare the decision tree: keep trip, rebook, or delegate attendance, and draft the team note without sending it.",
      plannerIncludesAny: ["owner_send_message", "approval", "travel"],
      responseIncludesAny: ["decision", "rebook", "delegate", "draft"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
