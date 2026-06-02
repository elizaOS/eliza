import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "insurance-claim-paperwork",
  title: "Assistant assembles an insurance claim packet with owner approval",
  domain: "executive.documents",
  tags: ["lifeops", "executive-assistant", "documents", "money"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Insurance Claim Paperwork",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-claim-materials",
      text: "My luggage claim is due Friday. Pull the receipts, flight info, photos, and policy details into one packet. Do not submit it yet.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "receipt"],
      responseIncludesAny: ["claim", "packet", "receipts", "approval"],
      plannerExcludes: ["send_to_agent", "list_agents"],
    },
    {
      kind: "message",
      name: "draft-insurer-followup",
      text: "Draft the insurer message and create a reminder to review it tomorrow afternoon.",
      plannerIncludesAll: ["SCHEDULED_TASKS"],
      plannerIncludesAny: ["draft", "insurer", "tomorrow"],
      responseIncludesAny: ["draft", "reminder", "review"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
