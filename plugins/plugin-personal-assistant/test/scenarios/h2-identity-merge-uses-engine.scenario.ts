/**
 * H2 duplicate-identity capture must collapse through the ENTITY merge engine,
 * never a side-channel write. Two duplicate Sarah nodes (Gmail + Telegram) are
 * seeded into the real EntityStore, the owner asks to merge them, and the final
 * checks read the store back: the surviving target persists and BOTH source
 * nodes are gone — the merge-engine outcome (frozen contract: never bypass it),
 * asserted against persisted rows rather than the scripted action arguments.
 *
 * Fail-without-fix anchor: un-nest `options` and the merge no-ops via
 * PLANNER_SHOULDACT_FALSE, so the seeded source nodes remain and `entityAbsent`
 * reports they are still persisted.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  entityAbsent,
  entityPersisted,
  seedEntity,
} from "./_helpers/kg-live-capture.ts";

export default scenario({
  lane: "pr-deterministic",
  id: "h2-identity-merge-uses-engine",
  title: "H2 duplicate identity capture uses the ENTITY merge engine",
  domain: "lifeops.kg",
  tags: ["lifeops", "H2", "entity", "merge", "identity"],
  isolation: "per-scenario",
  rooms: [{ id: "main", source: "dashboard", channelType: "DM" }],
  seed: [
    {
      type: "custom",
      name: "seed surviving Sarah node",
      apply: seedEntity({
        entityId: "person-h2-sarah",
        type: "person",
        preferredName: "Sarah",
      }),
    },
    {
      type: "custom",
      name: "seed duplicate Sarah (Gmail)",
      apply: seedEntity({
        entityId: "person-h2-sarah-gmail",
        type: "person",
        preferredName: "Sarah (Gmail)",
      }),
    },
    {
      type: "custom",
      name: "seed duplicate Sarah (Telegram)",
      apply: seedEntity({
        entityId: "person-h2-sarah-telegram",
        type: "person",
        preferredName: "Sarah (Telegram)",
      }),
    },
  ],
  turns: [
    {
      kind: "action",
      name: "merge-duplicate-identities",
      room: "main",
      actionName: "ENTITY",
      text: "Merge Sarah from Gmail and Sarah from Telegram; they are the same person.",
      options: {
        parameters: {
          action: "merge",
          entityId: "person-h2-sarah",
          sourceEntityIds: [
            "person-h2-sarah-gmail",
            "person-h2-sarah-telegram",
          ],
          evidence: "owner confirmed cross-platform duplicate h2-merge-001",
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
      name: "surviving target entity persists after merge",
      predicate: entityPersisted({
        entityId: "person-h2-sarah",
        preferredNameIncludes: "Sarah",
      }),
    },
    {
      type: "custom",
      name: "Gmail duplicate collapsed by the merge engine",
      predicate: entityAbsent("person-h2-sarah-gmail"),
    },
    {
      type: "custom",
      name: "Telegram duplicate collapsed by the merge engine",
      predicate: entityAbsent("person-h2-sarah-telegram"),
    },
  ],
});
