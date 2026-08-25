/**
 * H2 duplicate-identity capture must collapse through the ENTITY merge engine,
 * never a side-channel write. Two duplicate Sarah nodes (Gmail + Telegram) are
 * seeded into the real EntityStore, the deterministic identity authority
 * merges them through that store, and the final checks read the store back:
 * the surviving target persists and BOTH source nodes are gone.
 *
 * Fail-without-fix anchor: bypass or remove the authority merge seed and the
 * source nodes remain, so `entityAbsent` reports they are still persisted.
 */
import { scenario } from "@elizaos/scenario-runner/schema";
import {
  entityAbsent,
  entityPersisted,
  mergeEntitiesThroughIdentityAuthority,
  seedEntity,
} from "./_helpers/kg-live-capture.ts";

export default scenario({
  lane: "pr-deterministic",
  modelFixtures: {
    mode: "fixtures",
    fixtures: [
      {
        name: "entity-owner-facing-copy",
        match: { modelType: "TEXT_SMALL", toolNames: [] },
        response: { text: "Sarah's identity record is unified." },
        cardinality: 1,
      },
    ],
  },
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
    {
      type: "custom",
      name: "merge duplicates through deterministic identity authority",
      apply: mergeEntitiesThroughIdentityAuthority("person-h2-sarah", [
        "person-h2-sarah-gmail",
        "person-h2-sarah-telegram",
      ]),
    },
  ],
  turns: [
    {
      kind: "action",
      name: "read-authority-merged-identity",
      room: "main",
      actionName: "ENTITY",
      text: "Show me Sarah's unified identity record.",
      options: {
        parameters: {
          action: "read",
          entityId: "person-h2-sarah",
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
