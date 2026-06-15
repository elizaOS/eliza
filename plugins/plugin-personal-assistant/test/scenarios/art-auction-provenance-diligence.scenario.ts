import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "art-auction-provenance-diligence",
  title: "Assistant coordinates art auction provenance diligence",
  domain: "executive.legal",
  tags: ["lifeops", "executive-assistant", "legal", "money", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Art Auction Provenance Diligence",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "assemble-provenance-review",
      text: "Before we bid on the painting, gather provenance, condition report, lien search, buyer premium, shipping estimate, and counsel's authenticity notes.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "deadline"],
      responseIncludesAny: ["provenance", "condition", "lien", "premium"],
      plannerExcludes: ["PAYMENT_EXECUTED"],
    },
    {
      kind: "message",
      name: "prepare-bid-approval",
      text: "Prepare a bid approval memo with red flags and ask me before sending anything to the auction house or authorizing escrow.",
      plannerIncludesAny: ["approval", "owner_send_message", "privacy"],
      responseIncludesAny: ["approval", "red flags", "auction house", "escrow"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
