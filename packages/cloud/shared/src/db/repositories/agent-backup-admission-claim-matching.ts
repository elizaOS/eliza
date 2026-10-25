/**
 * Selects a deterministic maximum-cardinality set of backup admission lanes.
 *
 * Input order is the canonical candidate rank. Each organization and node
 * occurrence may appear at most once in the returned batch.
 */

import {
  AGENT_BACKUP_ADMISSION_SHARD_COUNT,
  type AgentBackupAdmissionWorkKind,
} from "../schemas/agent-backup-admission";

const MAXIMUM_LANE_BATCH_SIZE = 100;
const CANONICAL_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type ExactDatabaseInteger = bigint | number | string;

/** Exact restart position inside one frozen claim cycle. */
export interface AgentBackupAdmissionClaimPosition {
  readyCohort: ExactDatabaseInteger;
  cohortOrdinal: number;
  /** Opaque work UUID tie-breaker. It never determines the shard. */
  id: string;
}

/**
 * Frozen authority for one claim pass.
 *
 * Timestamp ranks are integer microseconds calculated by PostgreSQL. Keeping
 * them as integers avoids losing the final three digits through JavaScript's
 * millisecond-only `Date` representation.
 */
export interface AgentBackupAdmissionClaimMatchingAuthority {
  workKind: AgentBackupAdmissionWorkKind;
  shardId: number;
  cycleObservedAtRank: ExactDatabaseInteger;
  priorityPass: number;
  highWater: AgentBackupAdmissionClaimPosition;
  cursor: AgentBackupAdmissionClaimPosition | null;
}

export interface AgentBackupAdmissionLaneCandidate {
  id: string;
  organizationId: string;
  nodeHistoryId: string;
}

export interface AgentBackupAdmissionPrioritizedLaneCandidate
  extends AgentBackupAdmissionLaneCandidate {
  workKind: AgentBackupAdmissionWorkKind;
  /** `sandbox_id`, `backup_id`, or `gc_object_id`, according to `workKind`. */
  shardSourceId: string;
  /** Persisted source-derived shard; `id` is deliberately not consulted. */
  shardId: number;
  notBeforeRank: ExactDatabaseInteger;
  readyCohort: ExactDatabaseInteger;
  cohortOrdinal: number;
  effectivePriority: number;
}

interface RankedLaneCandidate<T extends AgentBackupAdmissionLaneCandidate> {
  candidate: T;
  rank: number;
}

function requireLaneBatchLimit(limit: number): number {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAXIMUM_LANE_BATCH_SIZE) {
    throw new RangeError(`limit must be an integer between 0 and ${MAXIMUM_LANE_BATCH_SIZE}`);
  }
  return limit;
}

function requireBoundedInteger(value: number, min: number, max: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new RangeError(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function requireExactNonNegativeInteger(value: ExactDatabaseInteger, field: string): bigint {
  if (typeof value === "bigint") {
    if (value >= 0n) return value;
  } else if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  } else if (/^(0|[1-9][0-9]*)$/.test(value)) {
    return BigInt(value);
  }
  throw new RangeError(`${field} must be a canonical non-negative database integer`);
}

function finalPriorityPass(workKind: AgentBackupAdmissionWorkKind): number {
  switch (workKind) {
    case "schedule_capture":
      return 3;
    case "catalog_operation":
      return 5;
    case "gc_object":
      return 6;
  }
}

function expectedShardForSourceUuid(sourceId: string): number {
  if (!CANONICAL_UUID_PATTERN.test(sourceId)) {
    throw new RangeError("candidate shardSourceId must be a canonical lowercase UUID");
  }
  // Exact parity with agent_backup_admission_expected_shard(uuid): the first
  // byte of uuid_send(source_id), modulo the fixed shard count.
  return Number.parseInt(sourceId.slice(0, 2), 16) % AGENT_BACKUP_ADMISSION_SHARD_COUNT;
}

function compareClaimPositions(
  left: AgentBackupAdmissionClaimPosition,
  right: AgentBackupAdmissionClaimPosition,
): number {
  const leftCohort = requireExactNonNegativeInteger(left.readyCohort, "position readyCohort");
  const rightCohort = requireExactNonNegativeInteger(right.readyCohort, "position readyCohort");
  if (leftCohort < rightCohort) return -1;
  if (leftCohort > rightCohort) return 1;

  const leftOrdinal = requireBoundedInteger(
    left.cohortOrdinal,
    0,
    Number.MAX_SAFE_INTEGER,
    "position cohortOrdinal",
  );
  const rightOrdinal = requireBoundedInteger(
    right.cohortOrdinal,
    0,
    Number.MAX_SAFE_INTEGER,
    "position cohortOrdinal",
  );
  if (leftOrdinal < rightOrdinal) return -1;
  if (leftOrdinal > rightOrdinal) return 1;

  if (left.id < right.id) return -1;
  if (left.id > right.id) return 1;
  return 0;
}

function requireClaimAuthority(
  authority: AgentBackupAdmissionClaimMatchingAuthority,
): AgentBackupAdmissionClaimMatchingAuthority {
  requireBoundedInteger(
    authority.shardId,
    0,
    AGENT_BACKUP_ADMISSION_SHARD_COUNT - 1,
    "authority shardId",
  );
  requireExactNonNegativeInteger(authority.cycleObservedAtRank, "authority cycleObservedAtRank");
  requireBoundedInteger(
    authority.priorityPass,
    0,
    finalPriorityPass(authority.workKind),
    "authority priorityPass",
  );
  compareClaimPositions(authority.highWater, authority.highWater);
  if (authority.cursor && compareClaimPositions(authority.cursor, authority.highWater) > 0) {
    throw new RangeError("authority cursor must not be beyond its frozen highWater");
  }
  return authority;
}

function candidateIsInsideClaimAuthority(
  candidate: AgentBackupAdmissionPrioritizedLaneCandidate,
  authority: AgentBackupAdmissionClaimMatchingAuthority,
): boolean {
  requireBoundedInteger(
    candidate.shardId,
    0,
    AGENT_BACKUP_ADMISSION_SHARD_COUNT - 1,
    "candidate shardId",
  );
  requireBoundedInteger(
    candidate.effectivePriority,
    0,
    finalPriorityPass(candidate.workKind),
    "candidate effectivePriority",
  );
  requireBoundedInteger(
    candidate.cohortOrdinal,
    0,
    Number.MAX_SAFE_INTEGER,
    "candidate cohortOrdinal",
  );
  const notBeforeRank = requireExactNonNegativeInteger(
    candidate.notBeforeRank,
    "candidate notBeforeRank",
  );
  const observedAtRank = requireExactNonNegativeInteger(
    authority.cycleObservedAtRank,
    "authority cycleObservedAtRank",
  );
  const position: AgentBackupAdmissionClaimPosition = {
    readyCohort: candidate.readyCohort,
    cohortOrdinal: candidate.cohortOrdinal,
    id: candidate.id,
  };

  return (
    candidate.workKind === authority.workKind &&
    candidate.shardId === authority.shardId &&
    candidate.shardId === expectedShardForSourceUuid(candidate.shardSourceId) &&
    candidate.effectivePriority === authority.priorityPass &&
    notBeforeRank <= observedAtRank &&
    compareClaimPositions(position, authority.highWater) <= 0 &&
    (authority.cursor === null || compareClaimPositions(position, authority.cursor) > 0)
  );
}

/**
 * Return up to `limit` candidates without organization or node-lane conflicts.
 * Duplicate lane pairs retain only their highest-ranked candidate.
 */
export function selectMaximumCardinalityLaneBatch<T extends AgentBackupAdmissionLaneCandidate>(
  rankedCandidates: readonly T[],
  limit: number,
): T[] {
  const boundedLimit = requireLaneBatchLimit(limit);
  if (boundedLimit === 0 || rankedCandidates.length === 0) return [];

  const candidatesByOrganization = new Map<string, Map<string, RankedLaneCandidate<T>>>();

  for (const [rank, candidate] of rankedCandidates.entries()) {
    let candidatesByNode = candidatesByOrganization.get(candidate.organizationId);
    if (!candidatesByNode) {
      candidatesByNode = new Map();
      candidatesByOrganization.set(candidate.organizationId, candidatesByNode);
    }

    if (!candidatesByNode.has(candidate.nodeHistoryId)) {
      candidatesByNode.set(candidate.nodeHistoryId, { candidate, rank });
    }
  }

  const matchedCandidateByNode = new Map<string, RankedLaneCandidate<T>>();

  const augment = (
    organizationId: string,
    visitedOrganizations: Set<string>,
    visitedNodes: Set<string>,
  ): boolean => {
    if (visitedOrganizations.has(organizationId)) return false;
    visitedOrganizations.add(organizationId);

    const candidatesByNode = candidatesByOrganization.get(organizationId);
    if (!candidatesByNode) return false;

    for (const [nodeHistoryId, rankedCandidate] of candidatesByNode) {
      if (visitedNodes.has(nodeHistoryId)) continue;
      visitedNodes.add(nodeHistoryId);

      const incumbent = matchedCandidateByNode.get(nodeHistoryId);
      if (
        incumbent &&
        !augment(incumbent.candidate.organizationId, visitedOrganizations, visitedNodes)
      ) {
        continue;
      }

      matchedCandidateByNode.set(nodeHistoryId, rankedCandidate);
      return true;
    }

    return false;
  };

  for (const organizationId of candidatesByOrganization.keys()) {
    if (matchedCandidateByNode.size === boundedLimit) break;
    augment(organizationId, new Set(), new Set());
  }

  return [...matchedCandidateByNode.values()]
    .sort((left, right) => left.rank - right.rank)
    .map(({ candidate }) => candidate);
}

/**
 * Maximize cardinality only inside the exact frozen claim authority.
 *
 * Work kind, the persisted source-derived shard, frozen DB-clock readiness,
 * effective-priority pass, high-water, and restart cursor must all match. The
 * opaque work UUID participates only in `(cohort, ordinal, id)` ordering.
 */
export function selectStrictPriorityLaneBatch<
  T extends AgentBackupAdmissionPrioritizedLaneCandidate,
>(
  rankedCandidates: readonly T[],
  authority: AgentBackupAdmissionClaimMatchingAuthority,
  limit: number,
): T[] {
  const boundedLimit = requireLaneBatchLimit(limit);
  const exactAuthority = requireClaimAuthority(authority);
  if (boundedLimit === 0 || rankedCandidates.length === 0) return [];
  return selectMaximumCardinalityLaneBatch(
    rankedCandidates.filter((candidate) =>
      candidateIsInsideClaimAuthority(candidate, exactAuthority),
    ),
    boundedLimit,
  );
}
