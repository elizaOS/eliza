import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "anonymous-donor-diligence",
  title: "Assistant manages anonymous donor diligence",
  domain: "executive.privacy",
  tags: ["lifeops", "executive-assistant", "privacy", "money", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Anonymous Donor Diligence",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "prepare-donor-diligence",
      text: "For the anonymous donation, gather charity vetting, gift agreement terms, naming-risk notes, wire instructions, and tax receipt requirements.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "privacy"],
      responseIncludesAny: ["charity", "gift agreement", "wire", "tax receipt"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "stage-donor-approval",
      text: "Prepare a private approval memo and do not reveal our identity or initiate any transfer without my written approval.",
      plannerIncludesAny: ["approval", "owner_send_message", "privacy"],
      responseIncludesAny: ["private", "identity", "transfer", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
