import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "art-shipping-insurance-claim",
  title: "Assistant manages a damaged art shipment and insurance claim",
  domain: "executive.vendor",
  tags: ["lifeops", "executive-assistant", "vendor", "documents", "money"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Art Shipping Insurance Claim",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "collect-damage-evidence",
      text: "The framed piece arrived damaged. Collect shipment docs, photos, appraisal, insurance rider, delivery timestamp, and vendor contacts into a claim packet.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "OWNER_FINANCES", "vendor"],
      responseIncludesAny: ["photos", "appraisal", "insurance", "claim"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "negotiate-claim-path",
      text: "Draft the shipper claim, gallery update, and insurer notice. Ask me before accepting any settlement or repair estimate.",
      plannerIncludesAny: ["owner_send_message", "approval", "followup"],
      responseIncludesAny: ["shipper", "gallery", "insurer", "approval"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
