/** Deterministic unit proofs for maximum-cardinality backup admission lane selection. */

import { describe, expect, test } from "bun:test";
import {
  type AgentBackupAdmissionClaimMatchingAuthority,
  type AgentBackupAdmissionLaneCandidate,
  type AgentBackupAdmissionPrioritizedLaneCandidate,
  selectMaximumCardinalityLaneBatch,
  selectStrictPriorityLaneBatch,
} from "../agent-backup-admission-claim-matching";

const SHARD_ID = 7;
const SHARD_SOURCE_ID = "07000000-0000-4000-8000-000000000000";
const OBSERVED_AT_RANK = "1787911200123456";
const HIGH_WATER_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";

const authority = (
  overrides: Partial<AgentBackupAdmissionClaimMatchingAuthority> = {},
): AgentBackupAdmissionClaimMatchingAuthority => ({
  workKind: "schedule_capture",
  shardId: SHARD_ID,
  cycleObservedAtRank: OBSERVED_AT_RANK,
  priorityPass: 0,
  highWater: {
    readyCohort: "100",
    cohortOrdinal: 10,
    id: HIGH_WATER_ID,
  },
  cursor: null,
  ...overrides,
});

function lane(
  id: string,
  organizationId: string,
  nodeHistoryId: string,
): AgentBackupAdmissionLaneCandidate {
  return { id, organizationId, nodeHistoryId };
}

function prioritizedLane(
  id: string,
  organizationId: string,
  nodeHistoryId: string,
  overrides: Partial<AgentBackupAdmissionPrioritizedLaneCandidate> = {},
): AgentBackupAdmissionPrioritizedLaneCandidate {
  return {
    id,
    organizationId,
    nodeHistoryId,
    workKind: "schedule_capture",
    shardSourceId: SHARD_SOURCE_ID,
    shardId: SHARD_ID,
    notBeforeRank: OBSERVED_AT_RANK,
    readyCohort: "100",
    cohortOrdinal: 0,
    effectivePriority: 0,
    ...overrides,
  };
}

describe("selectMaximumCardinalityLaneBatch", () => {
  test("uses an augmenting path instead of underfilling an adversarial frontier", () => {
    const candidates = [lane("a-x", "A", "X"), lane("a-y", "A", "Y"), lane("b-x", "B", "X")];

    expect(selectMaximumCardinalityLaneBatch(candidates, 100).map(({ id }) => id)).toEqual([
      "a-y",
      "b-x",
    ]);
  });

  test("keeps the highest-ranked candidate for a duplicate lane pair", () => {
    const candidates = [
      lane("best", "A", "X"),
      lane("duplicate", "A", "X"),
      lane("other", "B", "Y"),
    ];

    expect(selectMaximumCardinalityLaneBatch(candidates, 100).map(({ id }) => id)).toEqual([
      "best",
      "other",
    ]);
  });

  test("is deterministic and returns the final matching in stable rank order", () => {
    const candidates = [
      lane("a-x", "A", "X"),
      lane("a-y", "A", "Y"),
      lane("b-x", "B", "X"),
      lane("b-z", "B", "Z"),
      lane("c-y", "C", "Y"),
    ];
    const expected = ["a-x", "b-z", "c-y"];

    for (let iteration = 0; iteration < 20; iteration += 1) {
      expect(selectMaximumCardinalityLaneBatch(candidates, 100).map(({ id }) => id)).toEqual(
        expected,
      );
    }
  });

  test("enforces the explicit 100-candidate output cap", () => {
    const candidates = Array.from({ length: 150 }, (_, index) =>
      lane(`candidate-${index}`, `organization-${index}`, `node-${index}`),
    );

    const selected = selectMaximumCardinalityLaneBatch(candidates, 100);

    expect(selected).toHaveLength(100);
    expect(selected.map(({ id }) => id)).toEqual(candidates.slice(0, 100).map(({ id }) => id));
    expect(() => selectMaximumCardinalityLaneBatch(candidates, 101)).toThrow(
      "limit must be an integer between 0 and 100",
    );
  });
});

describe("selectStrictPriorityLaneBatch", () => {
  test("never admits work from another effective-priority pass", () => {
    const candidates = [
      prioritizedLane("00000000-0000-4000-8000-000000000001", "A", "X"),
      prioritizedLane("00000000-0000-4000-8000-000000000002", "A", "Y", {
        effectivePriority: 3,
      }),
      prioritizedLane("00000000-0000-4000-8000-000000000003", "B", "X", {
        effectivePriority: 3,
      }),
    ];

    expect(selectStrictPriorityLaneBatch(candidates, authority(), 100).map(({ id }) => id)).toEqual(
      ["00000000-0000-4000-8000-000000000001"],
    );
  });

  test("maximizes cardinality within the exact priority pass", () => {
    const candidates = [
      prioritizedLane("00000000-0000-4000-8000-000000000001", "A", "X"),
      prioritizedLane("00000000-0000-4000-8000-000000000002", "A", "Y"),
      prioritizedLane("00000000-0000-4000-8000-000000000003", "B", "X"),
      prioritizedLane("00000000-0000-4000-8000-000000000004", "C", "Z", {
        effectivePriority: 1,
      }),
    ];

    expect(selectStrictPriorityLaneBatch(candidates, authority(), 100).map(({ id }) => id)).toEqual(
      ["00000000-0000-4000-8000-000000000002", "00000000-0000-4000-8000-000000000003"],
    );
  });

  test("treats the work UUID as opaque instead of deriving its shard", () => {
    const uuidWhoseFirstByteMapsToShard63 = "ff000000-0000-4000-8000-000000000001";

    expect(
      selectStrictPriorityLaneBatch(
        [prioritizedLane(uuidWhoseFirstByteMapsToShard63, "A", "X")],
        authority(),
        1,
      ).map(({ id }) => id),
    ).toEqual([uuidWhoseFirstByteMapsToShard63]);
  });

  test("derives the shard from the source UUID even when the work UUID resembles the authority shard", () => {
    const uuidWhoseFirstByteMapsToShard7 = "07000000-0000-4000-8000-000000000001";

    expect(
      selectStrictPriorityLaneBatch(
        [
          prioritizedLane(uuidWhoseFirstByteMapsToShard7, "A", "X", {
            shardSourceId: "08000000-0000-4000-8000-000000000000",
          }),
        ],
        authority(),
        1,
      ),
    ).toEqual([]);
  });

  test("requires the exact work kind and frozen DB-clock readiness snapshot", () => {
    const candidates = [
      prioritizedLane("10000000-0000-4000-8000-000000000001", "A", "X", {
        workKind: "catalog_operation",
      }),
      prioritizedLane("10000000-0000-4000-8000-000000000002", "B", "Y", {
        notBeforeRank: BigInt(OBSERVED_AT_RANK) + 1n,
      }),
      prioritizedLane("10000000-0000-4000-8000-000000000003", "C", "Z"),
    ];

    expect(selectStrictPriorityLaneBatch(candidates, authority(), 100).map(({ id }) => id)).toEqual(
      ["10000000-0000-4000-8000-000000000003"],
    );
  });

  test("uses exact cursor-exclusive and high-water-inclusive tuple bounds", () => {
    const cursorId = "20000000-0000-4000-8000-000000000002";
    const boundedAuthority = authority({
      highWater: { readyCohort: "100", cohortOrdinal: 2, id: HIGH_WATER_ID },
      cursor: { readyCohort: "100", cohortOrdinal: 1, id: cursorId },
    });
    const candidates = [
      prioritizedLane(cursorId, "A", "X", { cohortOrdinal: 1 }),
      prioritizedLane("20000000-0000-4000-8000-000000000003", "B", "Y", {
        cohortOrdinal: 1,
      }),
      prioritizedLane(HIGH_WATER_ID, "C", "Z", { cohortOrdinal: 2 }),
      prioritizedLane("00000000-0000-4000-8000-000000000004", "D", "W", {
        cohortOrdinal: 3,
      }),
    ];

    expect(
      selectStrictPriorityLaneBatch(candidates, boundedAuthority, 100).map(({ id }) => id),
    ).toEqual(["20000000-0000-4000-8000-000000000003", HIGH_WATER_ID]);
  });

  test("rejects a restart cursor beyond the frozen high-water", () => {
    expect(() =>
      selectStrictPriorityLaneBatch(
        [prioritizedLane("30000000-0000-4000-8000-000000000001", "A", "X")],
        authority({
          highWater: { readyCohort: "4", cohortOrdinal: 0, id: HIGH_WATER_ID },
          cursor: { readyCohort: "5", cohortOrdinal: 0, id: HIGH_WATER_ID },
        }),
        1,
      ),
    ).toThrow("authority cursor must not be beyond its frozen highWater");
  });
});
