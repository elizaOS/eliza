/**
 * H1 co-parent inference. Adds the `co_parent_of` edge type through ENTITY so
 * custody/logistics history can be represented structurally without relationship
 * commentary.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "h1.relationship_type.coparent_detected",
  title: "H1 co-parent history lands as co_parent_of",
  domain: "lifeops.relationships",
  tags: ["lifeops", "H1", "relationships", "co-parenting", "entity"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "H1 Co-parent Relationship",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "record-coparent-edge",
      room: "main",
      actionName: "ENTITY",
      text: "Record Jordan as my co-parent based on custody-swap and kid-logistics message history.",
      options: {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-h1-jordan",
        relationshipType: "co_parent_of",
        evidence:
          "Custody-swap, kid schedule, and shared expense logistics message history.",
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
      includesAll: ["co_parent_of", "custody", "kid"],
    },
  ],
});
