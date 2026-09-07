/** Builds trusted sandbox records and enforces execution-tier, image, and organization admission policies. */

import { ElizaError } from "@elizaos/core";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbTransaction } from "../../../db/client";
import { type AgentSandbox } from "../../../db/repositories/agent-sandboxes";
import { lockOrganizationPolicy } from "../../../db/repositories/organization-policy-generation";
import {
  type AgentExecutionTier,
  agentSandboxes,
  type NewAgentSandbox,
} from "../../../db/schemas/agent-sandboxes";
import { imageRepo } from "../../../db/utils/docker-image-ref";
import { containersEnv } from "../../config/containers-env";
import { QUOTA_COUNTED_STATUSES } from "../../constants/agent-sandbox-quota";
import { logger } from "../../utils/logger";
import { imageRequiresDigestPin, isCodingContainerImageAllowed } from "../coding-containers";
import { withDefaultAgentCharacter } from "../default-agent-character";
import {
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "../eliza-agent-config";
import {
  readOrganizationQuotaPolicyInTransaction,
  requireOrganizationResourceLimit,
} from "../organization-quota-policy";

export interface CreateAgentParams {
  organizationId: string;
  userId: string;
  agentName: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
  characterId?: string;
  dockerImage?: string;
  /**
   * Explicit placement authority for the new row. Callers must decide whether
   * the agent is container-free Shared or owns dedicated/custom compute; the
   * persistence seam must never make that product decision by default.
   */
  executionTier: AgentExecutionTier;
  /**
   * Opt-in idempotency for single-agent-per-org flows (e.g. the onboarding
   * `POST /api/v1/eliza/agents` path and the eliza-app provisioner). When set,
   * createAgent takes an org-scoped advisory lock and reuses the org's existing
   * non-terminal agent instead of minting a duplicate — so a retry, an SDK
   * double-call, or a provision flap can't strand the org with N agents (each =
   * a container + per-tenant DB + ingress).
   *
   * Left unset by multi-agent-per-org service paths (waifu token launches, the
   * compat create endpoint) that legitimately create several distinct agents
   * for one org and must NOT collapse them.
   */
  reuseExistingNonTerminal?: boolean;
  /**
   * Ceiling on an org's resource-holding ({@link QUOTA_COUNTED_STATUSES},
   * non-pool) agent sandboxes, enforced ATOMICALLY under the org advisory lock
   * before ANY fresh insert — both the plain-insert branch and the reuse
   * branch's no-live-agent-to-reuse insert. Prevents a user-facing caller from
   * minting unbounded dedicated containers on the shared fleet (#11023: a
   * `forceCreate`+`alwaysOn` loop on a ~$0.11 balance otherwise exhausts the
   * fleet — the credit gate is threshold-only, never a per-agent debit). The
   * user-facing `POST /api/v1/eliza/agents` route sets this from the org's
   * balance tier; trusted internal multi-agent callers leave it unset (uncapped).
   * A create that would exceed the cap throws {@link AgentQuotaExceededError}.
   */
  maxNonTerminalAgents?: number;
  quotaMode?: "eager" | "non-eager";
  quotaAdmission?: "organization" | "trusted_internal";
}

/**
 * Statuses that COUNT toward `maxNonTerminalAgents`: the live states plus
 * `stopped` (suspend) and `sleeping` (cold storage). Both drop the container
 * and free the node slot, but each RETAINS the org's per-tenant managed
 * Postgres — the durable, costly resource — so a create→suspend→create loop
 * must not mint fresh agents (and fresh managed DBs) past the ceiling
 * (#11023 residual). Terminal/deletion states (`error`, `disconnected`,
 * `deletion_pending`, `deletion_failed`) hold no reusable resources and stay
 * excluded. `deletion_failed` in particular must not count (#15603): the
 * delete exhausted its retries — usually a node fault, not the user's — and
 * counting it would lock the org out of a replacement until ops intervene. A
 * container that survived the failed teardown is reclaimed independently of
 * this count (`reEnqueueFailedDeletions` re-arms the delete; the orphan
 * reconciler treats `deletion_failed` as reapable), and a user cannot drive a
 * row into that state on demand, so the freed slot stays bounded. Intentionally
 * BROADER than the reuse-guard SELECTs, which must keep returning only a LIVE
 * agent — handing back a stopped/sleeping row would silently turn an
 * idempotent create into an implicit resume.
 */
export { QUOTA_COUNTED_STATUSES } from "../../constants/agent-sandbox-quota";

/** Thrown by createAgent when a fresh create would exceed `maxNonTerminalAgents`. */
export class AgentQuotaExceededError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count: number, max: number) {
    super(
      `Agent quota exceeded: your organization already has ${count} active agents (limit ${max}). Remove an agent to free capacity.`,
    );
    this.name = "AgentQuotaExceededError";
    this.count = count;
    this.max = max;
  }
}

export function assertAgentExecutionTier(
  executionTier: unknown,
): asserts executionTier is AgentExecutionTier {
  if (
    executionTier !== "shared" &&
    executionTier !== "dedicated-lazy" &&
    executionTier !== "dedicated-always" &&
    executionTier !== "custom"
  ) {
    throw new ElizaError(
      "createAgent requires an explicit valid executionTier; refusing to default placement",
      {
        code: "INVALID_AGENT_EXECUTION_TIER",
        context: {
          executionTier: typeof executionTier === "string" ? executionTier : null,
          receivedType: typeof executionTier,
        },
      },
    );
  }
}

/**
 * Canonical value builder for a fresh `agent_sandboxes` insert. Every create
 * path — the sandbox service's own create/coding-container methods and the
 * tier-upgrade target mint (#15943) — MUST assemble its insert through this
 * function so config sanitization, character ownership, tier→status derivation,
 * and column defaults cannot drift between paths. `environmentVars` is expected
 * storage-ready (already passed through `encryptAgentEnvVarsForStorage`).
 *
 * A create that brings neither a linked `characterId` nor a persona in its
 * config is seeded with the shipped default character
 * ({@link withDefaultAgentCharacter}); seeding here rather than in any single
 * reader is what keeps the shared turn, the dedicated container, the warm-pool
 * claim push, and the first-boot bootstrap agreeing on one persona.
 */
export function buildAgentSandboxInsertValues(params: CreateAgentParams): NewAgentSandbox {
  const executionTier = params.executionTier;
  assertAgentExecutionTier(executionTier);
  const sanitizedConfig = stripReservedElizaConfigKeys(params.agentConfig);
  const agentConfig = params.characterId
    ? withReusedElizaCharacterOwnership(sanitizedConfig)
    : executionTier === "custom"
      ? sanitizedConfig
      : withDefaultAgentCharacter(sanitizedConfig);

  const status = executionTier === "shared" ? "running" : "pending";

  return {
    organization_id: params.organizationId,
    user_id: params.userId,
    agent_name: params.agentName,
    agent_config: agentConfig,
    environment_vars: params.environmentVars ?? {},
    status,
    execution_tier: executionTier,
    quota_admission_scope: params.quotaAdmission ?? "unclassified",
    database_status: "none",
    ...(params.characterId && { character_id: params.characterId }),
    ...(params.dockerImage && { docker_image: params.dockerImage }),
  };
}

/** Omits an empty custom-image overlay so a self-contained image keeps its bundled character. */
export function agentConfigForProvision(
  agent: Pick<AgentSandbox, "agent_config" | "execution_tier">,
): Record<string, unknown> | undefined {
  const config = agent.agent_config;
  if (!config || typeof config !== "object" || Array.isArray(config)) return undefined;
  const record = config as Record<string, unknown>;
  return agent.execution_tier === "custom" && Object.keys(record).length === 0 ? undefined : record;
}

/**
 * Enforce `maxNonTerminalAgents` for an org: count its quota-holding
 * ({@link QUOTA_COUNTED_STATUSES}), non-pool sandboxes and throw
 * {@link AgentQuotaExceededError} at/past the cap. MUST run inside a
 * transaction that already holds an org-serializing advisory lock (the
 * agent-create lock, or the tier-upgrade lock for a fixed source agent) so
 * the count→insert is atomic — two concurrent creates can't both read
 * `count = max-1` and both insert.
 */
export async function assertOrgAgentQuota(
  tx: DbTransaction,
  organizationId: string,
  _requestedCap: number,
  mode: "eager" | "non-eager" = "eager",
): Promise<void> {
  await lockOrganizationPolicy(tx, organizationId);
  const policy = await readOrganizationQuotaPolicyInTransaction(tx, organizationId);
  const cap = Number(
    requireOrganizationResourceLimit(
      policy,
      mode === "non-eager" ? "nonEagerSandboxes" : "sandboxes",
    ),
  );
  const [{ count } = { count: 0 }] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(agentSandboxes)
    .where(
      and(
        eq(agentSandboxes.organization_id, organizationId),
        sql`${agentSandboxes.pool_status} IS NULL`,
        inArray(agentSandboxes.status, QUOTA_COUNTED_STATUSES),
      ),
    );
  if (count >= cap) {
    throw new AgentQuotaExceededError(count, cap);
  }
}

/**
 * Thrown by createAgent when a caller-supplied `dockerImage` is not permitted by
 * the managed-agent image allowlist, or (when the digest-pin gate is armed) is
 * not pinned to a full sha256 digest (H1, #12230). Throwing here — before ANY
 * DB write or `docker pull` — is what makes the gate fail-closed across every
 * route that reaches createAgent, not just `POST /api/v1/eliza/agents`.
 */
export class AgentImageNotAllowedError extends Error {
  readonly image: string;
  readonly reason: "not_allowlisted" | "not_digest_pinned";
  constructor(image: string, reason: "not_allowlisted" | "not_digest_pinned") {
    super(
      reason === "not_digest_pinned"
        ? `Docker image '${image}' must be pinned to a full sha256 digest (e.g. ghcr.io/org/repo@sha256:<64 hex>).`
        : `Docker image '${image}' is not in the managed-agent image allowlist.`,
    );
    this.name = "AgentImageNotAllowedError";
    this.image = image;
    this.reason = reason;
  }
}

/**
 * Fail-closed gate for a caller-supplied managed-agent `dockerImage` (H1,
 * #12230). No image → the default first-party runtime image is used downstream,
 * nothing to gate. A supplied image must be on {@link
 * containersEnv.agentImageAllowlist} and, when the digest-pin gate is armed,
 * content-addressed. Throws {@link AgentImageNotAllowedError} otherwise.
 */
export function assertAgentImageAllowed(dockerImage: string | undefined): void {
  if (!dockerImage) return;
  const allowlist = containersEnv.agentImageAllowlist();
  if (!isCodingContainerImageAllowed(dockerImage, allowlist)) {
    logger.warn("[agent-sandbox] docker image rejected by allowlist", {
      image: dockerImage,
    });
    throw new AgentImageNotAllowedError(dockerImage, "not_allowlisted");
  }
  if (imageRequiresDigestPin(dockerImage, containersEnv.requireDigestPinnedImages())) {
    logger.warn("[agent-sandbox] docker image rejected: digest pin required", {
      image: dockerImage,
    });
    throw new AgentImageNotAllowedError(dockerImage, "not_digest_pinned");
  }
}

export function resolveManagedProvisionDockerImage(
  storedImage: string | null | undefined,
): string | undefined {
  const configuredImage = containersEnv.defaultAgentImageOverride();
  if (!configuredImage) return storedImage ?? undefined;
  // Same-repo managed pins are fleet image selections, not custom images; on
  // reprovision they must follow the operator's current image so recovery does
  // not replay an old broken sha tag forever.
  if (!storedImage) return configuredImage;
  return imageRepo(storedImage) === imageRepo(configuredImage) ? configuredImage : storedImage;
}

/**
 * Decide how the shared managed DB URL is exposed to an agent container (#8696).
 *
 * - A self-contained image that shipped its OWN `DATABASE_URL` keeps it; the
 *   managed URL is exposed under `ELIZA_MANAGED_DATABASE_URL` so it can opt in.
 * - A local-state agent (provisioned with `ELIZA_AGENT_LOCAL_STATE=1`) keeps
 *   agent-state in a local in-container PGlite DB on the persistent volume and
 *   uses the shared DB only for auth/discovery via the cloud API. The managed URL
 *   is exposed as `ELIZA_MANAGED_DATABASE_URL` (opt-in) and `DATABASE_URL` is left
 *   UNSET so plugin-sql falls back to local PGlite — removing the shared-Postgres
 *   connection hot path.
 * - Otherwise (existing agents with no flag) the managed URL is injected as
 *   `DATABASE_URL`, byte-identical to the prior behavior — a forward cutover with
 *   no migration.
 */
export function computeManagedAgentDbEnv(
  callerEnv: Record<string, string>,
  dbUri: string,
): Record<string, string> {
  const callerSuppliedDatabaseUrl =
    typeof callerEnv.DATABASE_URL === "string" && callerEnv.DATABASE_URL.trim().length > 0;
  const wantsLocalState = callerEnv.ELIZA_AGENT_LOCAL_STATE === "1";
  return callerSuppliedDatabaseUrl || wantsLocalState
    ? { ELIZA_MANAGED_DATABASE_URL: dbUri }
    : { DATABASE_URL: dbUri };
}
