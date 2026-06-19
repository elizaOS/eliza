import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "keynote-slide-fact-check-approval",
  title: "Assistant fact-checks keynote slides before approval",
  domain: "executive.briefing",
  tags: ["lifeops", "executive-assistant", "briefing", "documents", "approvals"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Keynote Slide Fact Check Approval",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "triage-slide-claims",
      text: "The keynote deck has numbers I do not trust. Check the claims, source docs, embargoed metrics, legal review status, and speaker notes before approval.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "priority", "privacy"],
      responseIncludesAny: ["claims", "source", "embargoed", "legal"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
    {
      kind: "message",
      name: "stage-fact-check-brief",
      text: "Prepare a slide-by-slide fact-check brief and edits for comms. Ask before sending the deck or exposing embargoed metrics.",
      plannerIncludesAny: ["owner_send_message", "approval", "privacy"],
      responseIncludesAny: ["slide-by-slide", "edits", "deck", "embargoed"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
