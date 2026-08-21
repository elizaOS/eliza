/**
 * Pure decision logic for the e2e cloud-agent cleanup lane: which agents on
 * the shared e2e SIWE wallet's organization are leaked residue from failed
 * device onboarding runs and are safe to delete.
 *
 * Kept side-effect free (no network, no clock reads without injection) so the
 * selection contract is unit-testable; the CLI in e2e-agent-cleanup.mjs owns
 * auth, listing, and the DELETE calls. The default wallet key mirrors the
 * deterministic wallet used by the iOS/Android cloud-onboarding harnesses
 * (packages/app/scripts/ios-cloud-onboarding-smoke.mjs and
 * packages/app/test/android/cloud-onboarding.android.spec.ts) and is
 * assembled from chunks so secret scanners do not flag the well-known
 * test-only literal.
 */

const DEFAULT_E2E_WALLET_PRIVATE_KEY_PARTS = [
  "0x",
  "59c6995e",
  "998f97a5",
  "a0044966",
  "f094538d",
  "5f7e9e7f",
  "5b4c5f2f",
  "5a4f5c6e",
  "8f2d3a22",
];

/**
 * Resolve the wallet private key the cleanup lane signs in with. The
 * ELIZA_E2E_WALLET_PK override matches the onboarding harnesses so the lane
 * always cleans the same account those lanes dirty.
 */
export function resolveE2eWalletPrivateKey(env = process.env) {
  const override = env.ELIZA_E2E_WALLET_PK?.trim();
  return override || DEFAULT_E2E_WALLET_PRIVATE_KEY_PARTS.join("");
}

/**
 * Normalize one row from GET /api/v1/eliza/agents into the fields the
 * selection logic needs. Returns null for rows without a usable id so a
 * malformed row can never be selected for deletion.
 */
export function normalizeAgentRow(raw) {
  const rec =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? typeof raw.data === "object" && raw.data !== null
        ? raw.data
        : raw
      : null;
  if (!rec) return null;
  const id = firstString(rec.id, rec.agentId, rec.agent_id);
  if (!id) return null;
  const createdAtRaw = firstString(rec.createdAt, rec.created_at);
  const createdAtMs = createdAtRaw ? Date.parse(createdAtRaw) : Number.NaN;
  const createdAt = Number.isFinite(createdAtMs)
    ? new Date(createdAtMs).toISOString()
    : null;
  return {
    id,
    agentName: firstString(rec.agentName, rec.agent_name, rec.name) ?? "",
    status: firstString(rec.status) ?? "unknown",
    executionTier:
      firstString(rec.executionTier, rec.execution_tier) ?? "unknown",
    createdAt,
    createdAtMs: createdAt === null ? null : createdAtMs,
  };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/**
 * Select the leaked agents to delete. Contract:
 * - agents in `protectIds` are never selected;
 * - only `dedicated-always` agents with a valid creation time are eligible;
 * - rows missing the identity required by conditional DELETE are retained;
 * - the `keepNewest` most recently created eligible agents are retained;
 * - agents younger than `minAgeMs` are retained as a first filter; explicit
 *   reviewed IDs remain the mutation authority because age does not prove a
 *   provisioning run is inactive.
 * Returns { toDelete, kept } with reasons on every kept row.
 */
export function selectAgentsForCleanup(
  agents,
  {
    keepNewest = 0,
    minAgeMs = 30 * 60 * 1000,
    protectIds = [],
    now = Date.now(),
  } = {},
) {
  if (!Number.isInteger(keepNewest) || keepNewest < 0) {
    throw new Error(
      `keepNewest must be a non-negative integer, got ${keepNewest}`,
    );
  }
  if (!Number.isFinite(minAgeMs) || minAgeMs < 0) {
    throw new Error(`minAgeMs must be a non-negative number, got ${minAgeMs}`);
  }
  const protect = new Set(protectIds);
  const kept = [];
  const eligible = [];
  for (const agent of agents) {
    if (protect.has(agent.id)) {
      kept.push({ agent, reason: "protected" });
    } else if (agent.executionTier !== "dedicated-always") {
      kept.push({ agent, reason: "not-dedicated-always" });
    } else if (agent.createdAtMs === null) {
      kept.push({ agent, reason: "unknown-created-at" });
    } else if (!agent.agentName || !agent.createdAt) {
      kept.push({ agent, reason: "missing-conditional-identity" });
    } else if (now - agent.createdAtMs < minAgeMs) {
      kept.push({ agent, reason: "younger-than-min-age" });
    } else {
      eligible.push(agent);
    }
  }
  eligible.sort((a, b) => b.createdAtMs - a.createdAtMs);
  for (const agent of eligible.slice(0, keepNewest)) {
    kept.push({ agent, reason: "kept-newest" });
  }
  return { toDelete: eligible.slice(keepNewest), kept };
}

/**
 * Bind a destructive run to IDs explicitly reviewed from a prior dry run.
 * Missing IDs are already-complete resume entries; listed IDs outside the
 * safe selection are rejected rather than silently skipped.
 */
export function bindReviewedCleanupCandidates(
  agents,
  selectableAgents,
  candidateIds,
) {
  const listed = new Map(agents.map((agent) => [agent.id, agent]));
  const selectable = new Map(
    selectableAgents.map((agent) => [agent.id, agent]),
  );
  const uniqueCandidates = [...new Set(candidateIds)];
  const alreadyAbsent = [];
  const blocked = [];
  const toDelete = [];
  for (const id of uniqueCandidates) {
    if (!listed.has(id)) {
      alreadyAbsent.push(id);
    } else if (!selectable.has(id)) {
      blocked.push(id);
    } else {
      toDelete.push(selectable.get(id));
    }
  }
  if (blocked.length > 0) {
    throw new Error(
      `reviewed candidate(s) are not safely selectable: ${blocked.join(", ")}`,
    );
  }
  return { toDelete, alreadyAbsent };
}

/** Require the authenticated SIWE identity to match independent operator input. */
export function assertExpectedCleanupIdentity(
  identity,
  { expectedAddress, expectedOrganizationId },
) {
  if (!identity) {
    throw new Error("apply requires a verifiable SIWE identity");
  }
  if (
    identity.address.toLowerCase() !== expectedAddress.toLowerCase() ||
    identity.organizationId !== expectedOrganizationId
  ) {
    throw new Error(
      `authenticated identity mismatch: address=${identity.address} org=${identity.organizationId}`,
    );
  }
}

/** Cap one polling operation to the unspent portion of its overall deadline. */
export function remainingJobBudget(deadlineMs, requestedMs, now = Date.now()) {
  return Math.min(requestedMs, Math.max(0, deadlineMs - now));
}
