/**
 * H2 live relationship capture through ENTITY. The scenario writes a typed edge
 * with evidence so the final assertion targets the captured primitive, not a
 * paraphrase in chat.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "h2.kg_capture.relationship_update_live",
  title: "H2 relationship update lands in ENTITY with evidence",
  domain: "lifeops.kg",
  tags: ["lifeops", "H2", "entity", "relationship", "evidence"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "action",
      name: "capture-friend-edge",
      room: "main",
      actionName: "ENTITY",
      text: "Remember that Mira is a friend I coordinate neighborhood logistics with.",
      options: {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-h2-mira",
        relationshipType: "friend_of",
        evidence: "owner chat h2-rel-001",
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
      includesAll: ["friend_of", "person-h2-mira", "h2-rel-001"],
    },
  ],
});
