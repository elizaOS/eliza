import { describe, expect, test } from "bun:test";
import {
  type AgentBackupAdmissionMatchingCandidate,
  agentBackupAdmissionMatchingKernelBound,
  selectAgentBackupAdmissionMatchingCandidates,
} from "../agent-backup-admission-matching";

interface TestCandidate extends AgentBackupAdmissionMatchingCandidate {
  readonly label: string;
}

function candidate(params: {
  id: string;
  organizationId: string;
  nodeLaneId?: string | null;
  effectivePriority?: number;
}): TestCandidate {
  return {
    ...params,
    label: params.id,
    effectivePriority: params.effectivePriority ?? 0,
  };
}

function ids(candidates: readonly TestCandidate[]): string[] {
  return candidates.map(({ id }) => id);
}

function bruteForceSelection(candidates: readonly TestCandidate[], limit: number): TestCandidate[] {
  if (limit === 0) return [];
  const priorities = [
    ...new Set(candidates.map(({ effectivePriority }) => effectivePriority)),
  ].sort((left, right) => left - right);
  const selected: TestCandidate[] = [];
  const usedOrganizations = new Set<string>();
  const usedNodeLanes = new Set<string>();

  for (const priority of priorities) {
    const remaining = limit - selected.length;
    if (remaining === 0) break;
    const band = candidates.filter(
      (entry) =>
        entry.effectivePriority === priority &&
        !usedOrganizations.has(entry.organizationId) &&
        (entry.nodeLaneId == null || !usedNodeLanes.has(entry.nodeLaneId)),
    );
    if (band.length > 30) throw new Error("Brute-force oracle received too many candidates");

    let bestMask = 0;
    let bestSize = -1;
    for (let mask = 0; mask < 2 ** band.length; mask += 1) {
      const size = countBits(mask);
      if (size > remaining || size < bestSize) continue;
      const organizations = new Set<string>();
      const nodeLanes = new Set<string>();
      let valid = true;
      for (const [index, entry] of band.entries()) {
        if ((mask & (2 ** index)) === 0) continue;
        if (
          organizations.has(entry.organizationId) ||
          (entry.nodeLaneId != null && nodeLanes.has(entry.nodeLaneId))
        ) {
          valid = false;
          break;
        }
        organizations.add(entry.organizationId);
        if (entry.nodeLaneId != null) nodeLanes.add(entry.nodeLaneId);
      }
      if (!valid) continue;
      if (size > bestSize || (size === bestSize && isLexicographicallyEarlier(mask, bestMask))) {
        bestMask = mask;
        bestSize = size;
      }
    }

    for (const [index, entry] of band.entries()) {
      if ((bestMask & (2 ** index)) === 0) continue;
      selected.push(entry);
      usedOrganizations.add(entry.organizationId);
      if (entry.nodeLaneId != null) usedNodeLanes.add(entry.nodeLaneId);
    }
  }
  return selected;
}

function countBits(value: number): number {
  let remaining = value;
  let count = 0;
  while (remaining > 0) {
    count += remaining & 1;
    remaining = Math.floor(remaining / 2);
  }
  return count;
}

/** A selected earlier bit wins at the first differing ordered candidate. */
function isLexicographicallyEarlier(leftMask: number, rightMask: number): boolean {
  const difference = leftMask ^ rightMask;
  if (difference === 0) return false;
  const earliestDifferingBit = difference & -difference;
  return (leftMask & earliestDifferingBit) !== 0;
}

function forEachOrderedSubset<T>(
  values: readonly T[],
  visit: (ordered: readonly T[]) => void,
): void {
  const used = Array<boolean>(values.length).fill(false);
  const ordered: T[] = [];
  const walk = (): void => {
    visit([...ordered]);
    for (const [index, value] of values.entries()) {
      if (used[index]) continue;
      used[index] = true;
      ordered.push(value);
      walk();
      ordered.pop();
      used[index] = false;
    }
  };
  walk();
}

describe("agent backup admission matching", () => {
  test("fills the center-first crossing with a maximum-cardinality matching", () => {
    const crossing = [
      candidate({ id: "A-X", organizationId: "A", nodeLaneId: "X" }),
      candidate({ id: "A-Y", organizationId: "A", nodeLaneId: "Y" }),
      candidate({ id: "C-X", organizationId: "C", nodeLaneId: "X" }),
    ];

    expect(ids(selectAgentBackupAdmissionMatchingCandidates(crossing, 2))).toEqual(["A-Y", "C-X"]);
  });

  test("uses exact input-order preference among maximum-cardinality matchings", () => {
    const frontier = [
      candidate({ id: "A-X", organizationId: "A", nodeLaneId: "X" }),
      candidate({ id: "A-Y", organizationId: "A", nodeLaneId: "Y" }),
      candidate({ id: "B-X", organizationId: "B", nodeLaneId: "X" }),
      candidate({ id: "B-Z", organizationId: "B", nodeLaneId: "Z" }),
    ];

    // Both A-X+B-Z and A-Y+B-X have cardinality two. The first set wins
    // because it can retain the earliest ordered candidate A-X.
    expect(ids(selectAgentBackupAdmissionMatchingCandidates(frontier, 2))).toEqual(["A-X", "B-Z"]);
  });

  test("exhausts stricter priority bands before reserving lanes for later bands", () => {
    const frontier = [
      candidate({
        id: "ordinary-C-X",
        organizationId: "C",
        nodeLaneId: "X",
        effectivePriority: 2,
      }),
      candidate({
        id: "critical-A-X",
        organizationId: "A",
        nodeLaneId: "X",
        effectivePriority: 0,
      }),
      candidate({
        id: "critical-A-Y",
        organizationId: "A",
        nodeLaneId: "Y",
        effectivePriority: 0,
      }),
      candidate({
        id: "ordinary-C-Y",
        organizationId: "C",
        nodeLaneId: "Y",
        effectivePriority: 2,
      }),
    ];

    expect(ids(selectAgentBackupAdmissionMatchingCandidates(frontier, 2))).toEqual([
      "critical-A-X",
      "ordinary-C-Y",
    ]);
  });

  test("treats absent node lanes as private while retaining the organization cap", () => {
    const frontier = [
      candidate({ id: "publication-A-1", organizationId: "A" }),
      candidate({ id: "publication-A-2", organizationId: "A", nodeLaneId: null }),
      candidate({ id: "publication-B", organizationId: "B" }),
    ];

    expect(ids(selectAgentBackupAdmissionMatchingCandidates(frontier, 3))).toEqual([
      "publication-A-1",
      "publication-B",
    ]);
  });

  test("matches every ordered small graph exactly like the brute-force oracle", () => {
    const universe = [
      candidate({ id: "A-X", organizationId: "A", nodeLaneId: "X" }),
      candidate({ id: "A-Y", organizationId: "A", nodeLaneId: "Y" }),
      candidate({ id: "A-publication", organizationId: "A" }),
      candidate({ id: "B-X", organizationId: "B", nodeLaneId: "X" }),
      candidate({ id: "B-Y", organizationId: "B", nodeLaneId: "Y" }),
      candidate({ id: "B-publication", organizationId: "B" }),
    ];
    let compared = 0;

    forEachOrderedSubset(universe, (ordered) => {
      for (let limit = 0; limit <= 3; limit += 1) {
        const expected = ids(bruteForceSelection(ordered, limit));
        const actual = ids(selectAgentBackupAdmissionMatchingCandidates(ordered, limit));
        if (actual.join("\0") !== expected.join("\0")) {
          throw new Error(
            `Matching diverged from oracle: ${JSON.stringify({
              ordered: ids(ordered),
              limit,
              expected,
              actual,
            })}`,
          );
        }
        compared += 1;
      }
    });

    expect(compared).toBe(7_828);
  });

  test("matches interleaved two-band graphs exactly like the brute-force oracle", () => {
    const base = [
      candidate({ id: "A-X", organizationId: "A", nodeLaneId: "X" }),
      candidate({ id: "A-Y", organizationId: "A", nodeLaneId: "Y" }),
      candidate({ id: "B-X", organizationId: "B", nodeLaneId: "X" }),
      candidate({ id: "B-Y", organizationId: "B", nodeLaneId: "Y" }),
    ];
    let compared = 0;

    for (let assignment = 0; assignment < 2 ** base.length; assignment += 1) {
      const assigned = base.map((entry, index) => ({
        ...entry,
        effectivePriority: (assignment & (2 ** index)) === 0 ? 0 : 1,
      }));
      forEachOrderedSubset(assigned, (ordered) => {
        for (let limit = 0; limit <= 3; limit += 1) {
          const expected = ids(bruteForceSelection(ordered, limit));
          const actual = ids(selectAgentBackupAdmissionMatchingCandidates(ordered, limit));
          if (actual.join("\0") !== expected.join("\0")) {
            throw new Error(
              `Priority matching diverged from oracle: ${JSON.stringify({
                ordered: ids(ordered),
                priorities: ordered.map(({ effectivePriority }) => effectivePriority),
                limit,
                expected,
                actual,
              })}`,
            );
          }
          compared += 1;
        }
      });
    }

    expect(compared).toBe(4_160);
  });

  test("exposes the exact bounded bipartite kernel size", () => {
    expect(agentBackupAdmissionMatchingKernelBound(0)).toBe(0);
    expect(agentBackupAdmissionMatchingKernelBound(1)).toBe(1);
    expect(agentBackupAdmissionMatchingKernelBound(2)).toBe(3);
    expect(agentBackupAdmissionMatchingKernelBound(100)).toBe(9_901);
    expect(() => agentBackupAdmissionMatchingKernelBound(-1)).toThrow("non-negative safe integer");
    expect(() => agentBackupAdmissionMatchingKernelBound(100_000_000)).toThrow(
      "exceeds safe integer range",
    );
  });

  test("rejects ambiguous or non-canonical pure inputs", () => {
    expect(() =>
      selectAgentBackupAdmissionMatchingCandidates(
        [
          candidate({ id: "duplicate", organizationId: "A", nodeLaneId: "X" }),
          candidate({ id: "duplicate", organizationId: "B", nodeLaneId: "Y" }),
        ],
        1,
      ),
    ).toThrow("Duplicate backup admission matching candidate id");
    expect(() =>
      selectAgentBackupAdmissionMatchingCandidates(
        [candidate({ id: "invalid-priority", organizationId: "A", effectivePriority: 0.5 })],
        1,
      ),
    ).toThrow("priority must be a safe integer");
    expect(() => selectAgentBackupAdmissionMatchingCandidates([], 0.5)).toThrow(
      "non-negative safe integer",
    );
  });
});
