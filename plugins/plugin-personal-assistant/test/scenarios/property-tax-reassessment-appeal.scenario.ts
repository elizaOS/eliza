import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "property-tax-reassessment-appeal",
  title: "Assistant prepares a property tax reassessment appeal",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "money", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Property Tax Reassessment Appeal",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-property-tax-evidence",
      text: "The reassessment looks too high. Gather assessment notice, comps, remodel records, assessor deadline, prior appeal history, and accountant contact.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "deadline"],
      responseIncludesAny: ["assessment", "comps", "deadline", "accountant"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "draft-assessor-appeal",
      text: "Draft the appeal packet checklist and a calendar reminder one week before filing. Ask me before authorizing any consultant fee.",
      plannerIncludesAny: ["SCHEDULED_TASKS", "owner_send_message", "approval"],
      responseIncludesAny: ["appeal", "calendar", "consultant", "fee"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
  ],
});
