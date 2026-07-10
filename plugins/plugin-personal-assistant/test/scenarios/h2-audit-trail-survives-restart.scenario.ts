/**
 * H2 provenance / audit-trail scenario. A relationship write carries a stable
 * `source-utterance:` evidence tag; the final check reads the edge back off the
 * real RelationshipStore and confirms that tag persisted on the stored
 * `evidence[]` — proving the captured edge is traceable to the utterance it came
 * from, not merely that the reply mentioned it.
 *
 * Fail-without-fix anchor: drop the `source-utterance:` prefix from the seeded
 * evidence (or un-nest `options`) and the read-back reports the persisted edge
 * is missing that evidence string.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { relationshipEdgePersisted } from "./_helpers/kg-live-capture.ts";

export default scenario({
  lane: "pr-deterministic",
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
        parameters: {
          action: "set_relationship",
          fromEntityId: "self",
          toEntityId: "person-h2-priya",
          relationshipType: "colleague_of",
          evidence: "source-utterance:h2-audit-001",
        },
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
      type: "custom",
      name: "colleague_of edge persisted carrying the source-utterance evidence id",
      predicate: relationshipEdgePersisted({
        toEntityId: "person-h2-priya",
        type: "colleague_of",
        evidenceIncludes: ["source-utterance:h2-audit-001"],
      }),
    },
  ],
});
