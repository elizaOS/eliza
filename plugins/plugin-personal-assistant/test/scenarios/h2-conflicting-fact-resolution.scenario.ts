/**
 * H2 conflicting fact resolution: the owner first records a relationship label,
 * then corrects it. Both writes go through the ENTITY set_relationship subaction
 * and land as distinct typed edges (the store keys on from+to+type), so the
 * final checks read BOTH edges back off the real RelationshipStore and confirm
 * the correction (co_parent_of) is persisted with its own evidence alongside the
 * superseded label (partner_of) — the reconcile path is observable in the store,
 * not just in the reply text.
 *
 * Fail-without-fix anchor: revert either turn to the un-nested `options` shape
 * and that write no-ops via PLANNER_SHOULDACT_FALSE, so the corresponding
 * store read-back returns "RelationshipStore returned none".
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { relationshipEdgePersisted } from "./_helpers/kg-live-capture.ts";

export default scenario({
  lane: "pr-deterministic",
  id: "h2-conflicting-fact-resolution",
  title: "H2 owner correction supersedes captured relationship fact",
  domain: "lifeops.kg",
  tags: ["lifeops", "H2", "entity", "correction", "relationship"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "action",
      name: "capture-initial-label",
      room: "main",
      actionName: "ENTITY",
      text: "Record Jordan as partner_of from the old context.",
      options: {
        parameters: {
          action: "set_relationship",
          fromEntityId: "self",
          toEntityId: "person-h2-jordan",
          relationshipType: "partner_of",
          evidence: "older imported context h2-correct-001",
        },
      },
    },
    {
      kind: "action",
      name: "owner-corrects-label",
      room: "main",
      actionName: "ENTITY",
      text: "Correction: Jordan is my co-parent, not my partner.",
      options: {
        parameters: {
          action: "set_relationship",
          fromEntityId: "self",
          toEntityId: "person-h2-jordan",
          relationshipType: "co_parent_of",
          evidence: "owner correction h2-correct-002",
        },
      },
    },
  ],
  finalChecks: [
    {
      type: "actionCalled",
      actionName: "ENTITY",
      status: "success",
      minCount: 2,
    },
    {
      type: "custom",
      name: "corrected co_parent_of edge persisted with the correction evidence",
      predicate: relationshipEdgePersisted({
        toEntityId: "person-h2-jordan",
        type: "co_parent_of",
        evidenceIncludes: ["h2-correct-002"],
      }),
    },
    {
      type: "custom",
      name: "superseded partner_of edge is also persisted (reconcile is auditable)",
      predicate: relationshipEdgePersisted({
        toEntityId: "person-h2-jordan",
        type: "partner_of",
        evidenceIncludes: ["h2-correct-001"],
      }),
    },
  ],
});
