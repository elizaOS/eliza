/**
 * H2 conflicting fact resolution: the owner correction supersedes the earlier
 * captured label, and both writes go through ENTITY so the merge/reconcile path
 * stays observable.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
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
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-h2-jordan",
        relationshipType: "partner_of",
        evidence: "older imported context h2-correct-001",
      },
    },
    {
      kind: "action",
      name: "owner-corrects-label",
      room: "main",
      actionName: "ENTITY",
      text: "Correction: Jordan is my co-parent, not my partner.",
      options: {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-h2-jordan",
        relationshipType: "co_parent_of",
        evidence: "owner correction h2-correct-002",
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
      type: "selectedActionArguments",
      actionName: "ENTITY",
      includesAll: ["partner_of", "co_parent_of", "h2-correct-002"],
    },
  ],
});
