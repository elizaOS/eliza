import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  id: "pet-relocation-quarantine",
  title: "Assistant manages pet relocation paperwork and quarantine timing",
  domain: "executive.household",
  tags: ["lifeops", "executive-assistant", "household", "travel", "documents"],
  isolation: "per-scenario",
  requires: {
    plugins: ["@elizaos/plugin-agent-skills"],
  },
  rooms: [
    {
      id: "main",
      source: "dashboard",
      title: "LifeOps Pet Relocation Quarantine",
    },
  ],
  turns: [
    {
      kind: "message",
      name: "build-pet-relocation-runbook",
      text: "We're moving the dog to Singapore. Track vaccination certificate, import permit, airline crate rules, quarantine reservation, vet appointment, and flight handoff windows.",
      plannerIncludesAny: ["OWNER_DOCUMENTS", "calendar_action", "travel"],
      responseIncludesAny: ["vaccination", "permit", "quarantine", "vet"],
      plannerExcludes: ["OWNER_HEALTH"],
    },
    {
      kind: "message",
      name: "coordinate-vendor-and-family",
      text: "Draft messages for the vet, relocation vendor, and family calendar. Keep passport and microchip numbers out of broad messages.",
      plannerIncludesAny: ["owner_send_message", "privacy", "approval"],
      responseIncludesAny: ["vet", "vendor", "family", "microchip"],
      plannerExcludes: ["MESSAGE_SEND_CONFIRMED"],
    },
  ],
});
