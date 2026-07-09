/**
 * H2 live relationship capture through ENTITY. The owner names a typed edge
 * with a source-utterance evidence tag; the final check reads the edge back off
 * the real per-agent RelationshipStore (`eliza_knowledge_graph` service) and
 * asserts the persisted primitive — not the scripted action arguments, which
 * the runner records verbatim whether or not the write actually happened.
 *
 * Fail-without-fix anchor: nest the ENTITY subaction under `options` instead of
 * `options.parameters` (the shape `getParams` reads) and the action falls into
 * the planner-clarification branch (`PLANNER_SHOULDACT_FALSE`), persists
 * nothing, and the store read-back returns "RelationshipStore returned none".
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import { relationshipEdgePersisted } from "./_helpers/kg-live-capture.ts";

export default scenario({
  lane: "pr-deterministic",
  id: "h2-relationship-update-live",
  title: "H2 relationship update lands in the RelationshipStore with evidence",
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
        parameters: {
          action: "set_relationship",
          fromEntityId: "self",
          toEntityId: "person-h2-mira",
          relationshipType: "friend_of",
          evidence: "owner chat h2-rel-001",
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
      name: "friend_of edge persisted to person-h2-mira with source evidence",
      predicate: relationshipEdgePersisted({
        toEntityId: "person-h2-mira",
        type: "friend_of",
        evidenceIncludes: ["h2-rel-001"],
      }),
    },
  ],
});
