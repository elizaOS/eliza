/**
 * H2 duplicate identity capture must use ENTITY merge, never a side-channel
 * write. The action arguments are the evidence that the merge engine path was
 * requested.
 */
import { scenario } from "@elizaos/scenario-runner/schema";

export default scenario({
  lane: "live-only",
  id: "h2.kg_capture.identity_merge_uses_engine",
  title: "H2 duplicate identity capture uses ENTITY merge",
  domain: "lifeops.kg",
  tags: ["lifeops", "H2", "entity", "merge", "identity"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  turns: [
    {
      kind: "action",
      name: "merge-duplicate-identities",
      room: "main",
      actionName: "ENTITY",
      text: "Merge Sarah from Gmail and Sarah from Telegram; they are the same person.",
      options: {
        action: "merge",
        entityId: "person-h2-sarah",
        sourceEntityIds: ["person-h2-sarah-gmail", "person-h2-sarah-telegram"],
        evidence: "owner confirmed cross-platform duplicate h2-merge-001",
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
      includesAll: [
        "merge",
        "person-h2-sarah-gmail",
        "person-h2-sarah-telegram",
      ],
    },
  ],
});
