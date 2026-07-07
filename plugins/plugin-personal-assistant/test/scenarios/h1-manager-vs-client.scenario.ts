/**
 * H1 manager/client relationship-type inference. The scenario writes explicit
 * relationship edges with provenance so the graph stores a typed edge rather
 * than a vague contact note.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "h1-manager-vs-client",
  title: "H1 manager/report relationship types land as typed edges",
  domain: "lifeops.relationships",
  tags: ["lifeops", "H1", "relationships", "entity", "knowledge-graph"],
  isolation: "per-scenario",
  rooms: [
    {
      id: "main",
      source: "dashboard",
      channelType: "DM",
      title: "H1 Manager Relationship",
    },
  ],
  turns: [
    {
      kind: "action",
      name: "record-manager-edge",
      room: "main",
      actionName: "ENTITY",
      text: "Record that Priya manages me based on recurring directive work messages.",
      options: {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-h1-priya",
        relationshipType: "managed_by",
        evidence:
          "Recurring weekday directives and status-review messages from Priya.",
      },
    },
    {
      kind: "action",
      name: "record-report-edge",
      room: "main",
      actionName: "ENTITY",
      text: "Record that I manage Rowan based on recurring status-update messages.",
      options: {
        action: "set_relationship",
        fromEntityId: "self",
        toEntityId: "person-h1-rowan",
        relationshipType: "manages",
        evidence:
          "Recurring task assignment and status-update messages with Rowan.",
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
      includesAll: ["managed_by", "manages", "evidence"],
    },
  ],
});
