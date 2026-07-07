/**
 * H2 provenance/audit trail scenario. A relationship write includes a stable
 * source utterance id so later route/read-back evidence can prove where the
 * edge came from.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "h2-audit-trail-survives-restart",
  title: "H2 captured relationship carries stable source evidence",
  domain: "lifeops.kg",
  tags: ["lifeops", "H2", "entity", "provenance", "audit"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "action",
      name: "capture-edge-with-source-id",
      room: "main",
      actionName: "ENTITY",
      text: "Remember that Priya is my colleague and preserve this utterance as the evidence.",
      options: {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-h2-priya",
        relationshipType: "colleague_of",
        evidence: "source-utterance:h2-audit-001",
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "ENTITY",
      status: "success",
      minCount: 1,
    },
    {
      type: "selectedActionArguments",
      actionName: "ENTITY",
      includesAll: ["colleague_of", "source-utterance:h2-audit-001"],
    },
  ],
});
