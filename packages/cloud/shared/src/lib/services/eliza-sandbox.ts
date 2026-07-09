/**
 * Agent Sandbox Service — orchestrates cloud agent lifecycle:
 * Agent database assignment (shared Railway Postgres), Docker sandbox creation, bridge proxy, backups, heartbeat.
 */

import crypto from "node:crypto";
import { isIP } from "node:net";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { type Database, dbWrite } from "../../db/helpers";
import { agentBillingRepository } from "../../db/repositories/agent-billing";
import {
  type AgentBackupSnapshotType,
  type AgentSandbox,
  type AgentSandboxBackup,
  type AgentSandboxBackupMetadata,
  type AgentSandboxStatus,
  agentSandboxesRepository,
  prepareAgentBackupInsertData,
} from "../../db/repositories/agent-sandboxes";
import { userCharactersRepository } from "../../db/repositories/characters";
import { dockerNodesRepository } from "../../db/repositories/docker-nodes";
import { sharedRuntimeHistoryRepository } from "../../db/repositories/shared-runtime-history";
import {
  type AgentBackupStateData,
  type AgentExecutionTier,
  agentSandboxBackups,
  agentSandboxes,
  type NewAgentSandbox,
  type NewAgentSandboxBackup,
} from "../../db/schemas/agent-sandboxes";
import { jobs } from "../../db/schemas/jobs";
import { imageRepo } from "../../db/utils/docker-image-ref";
import { InsufficientCreditsError as InsufficientCreditsApiError } from "../api/errors";
import { containersEnv } from "../config/containers-env";
import { getElizaAgentPublicWebUiUrl } from "../eliza-agent-web-ui";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { assertSafeOutboundUrl } from "../security/outbound-url";
import { logger } from "../utils/logger";
import { withTimeout } from "../utils/with-timeout";
import {
  computeStateHash,
  estimateDeltaBytes,
  incrementalChainDepth,
  planIncrementalBackup,
} from "./agent-backup-diff";
import { decryptAgentEnvVars, encryptAgentEnvVarsForStorage } from "./agent-env-crypto";
import {
  type AIUsage,
  type BillingContext,
  billUsage,
  estimateInputTokens,
  InsufficientCreditsError,
  recordUsageAnalytics,
  reserveCredits,
} from "./ai-billing";
import { aiBillingRecordsService } from "./ai-billing-records";
import { apiKeysService } from "./api-keys";
import { imageRequiresDigestPin, isCodingContainerImageAllowed } from "./coding-containers";
import type { CreditReconciliationResult, CreditReservation } from "./credits";
import type { DockerSandboxMetadata } from "./docker-sandbox-provider";
import { shellQuote } from "./docker-sandbox-utils";
import { DockerSSHClient } from "./docker-ssh";
import {
  reusesExistingElizaCharacter,
  stripReservedElizaConfigKeys,
  withReusedElizaCharacterOwnership,
} from "./eliza-agent-config";
import {
  elizaAgentCreateAdvisoryLockSql,
  elizaCodingContainerImageAdvisoryLockSql,
  elizaProvisionAdvisoryLockSql,
} from "./eliza-provision-lock";
import { applyManagedAgentInferenceEnvDefaults } from "./managed-eliza-config";
import { prepareManagedElizaEnvironment } from "./managed-eliza-env";
import { JOB_TYPES } from "./provisioning-job-types";
import { mergeRuntimeAgentSecretsFromEnv } from "./runtime-agent-secrets";
import { resolveSandboxContainerLaunchConfig } from "./sandbox-container-launch-config";
import {
  createSandboxProvider,
  type SandboxHandle,
  type SandboxProvider,
} from "./sandbox-provider";
import { isDedicatedBootstrapWindow } from "./shared-runtime/dedicated-bootstrap";
import {
  type RunSharedAgentTurnResult,
  resolveSharedAgentTurnModel,
  runSharedAgentTurn,
  type SharedAgentCharacter,
  type SharedTurnMessage,
} from "./shared-runtime/run-shared-agent-turn";
import { applyPooledCredentialsToBootstrapEnv } from "./team-credential-pool/bootstrap-env";

export interface CreateAgentParams {
  organizationId: string;
  userId: string;
  agentName: string;
  agentConfig?: Record<string, unknown>;
  environmentVars?: Record<string, string>;
  characterId?: string;
  dockerImage?: string;
  executionTier?: AgentExecutionTier;
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
const QUOTA_COUNTED_STATUSES: AgentSandboxStatus[] = [
  "pending",
  "provisioning",
  "running",
  "stopped",
  "sleeping",
];

/** Thrown by createAgent when a fresh create would exceed `maxNonTerminalAgents`. */
export class AgentQuotaExceededError extends Error {
  readonly count: number;
  readonly max: number;
  constructor(count: number, max: number) {
    super(
      `Agent quota exceeded: your organization already has ${count} active agents (limit ${max}). Delete or stop an agent, or add credits to raise the limit.`,
    );
    this.name = "AgentQuotaExceededError";
    this.count = count;
    this.max = max;
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

function resolveManagedProvisionDockerImage(
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
 * Thrown when the post-create readiness probe could not REACH the container
 * (SSH transport unresolved), as distinct from the container being genuinely
 * not-ready. The provision path uses it to keep the container in place and
 * return a RETRYABLE failure instead of tearing down a likely-healthy container
 * and marking the row terminally failed (#15310 failure mode #6).
 */
export class SandboxTransportUnresolvedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxTransportUnresolvedError";
  }
}

export type ProvisionResult =
  | {
      success: true;
      sandboxRecord: AgentSandbox;
      bridgeUrl: string;
      healthUrl: string;
    }
  | {
      success: false;
      sandboxRecord?: AgentSandbox;
      error: string;
      /**
       * True when the failure is a transient, retryable condition (e.g. the
       * readiness probe could not reach the container). The provision JOB
       * should retry rather than treat this as a permanent failure that flips
       * the sandbox row to `error`. Absent/false = terminal.
       */
      retryable?: boolean;
    };

export type DeleteAgentResult =
  | { success: true; deletedSandbox: AgentSandbox }
  | { success: false; error: string };

/**
 * Outcome of the bounded container teardown attempted during `deleteAgent`:
 * `null` = stop succeeded; `{ error }` = stop failed within the cap (classified
 * downstream as ignorable vs real); `{ error, timedOut }` = the teardown hit the
 * hard cap and was abandoned (see `runBoundedSandboxStop`).
 */
export type BoundedSandboxStopResult =
  | null
  | { error: unknown }
  | { error: unknown; timedOut: true };

export interface BridgeRequest {
  jsonrpc: "2.0";
  id?: string | number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * JSON-RPC error code for a shared-runtime turn rejected by the credit
 * reserve. REST callers (shared-rest-adapter, the messages/stream route)
 * match on this code to translate the failure into the canonical 402
 * insufficient-credits response instead of a generic retryable failure —
 * an empty balance is permanent until the org tops up, not a transient
 * outage.
 */
export const BRIDGE_INSUFFICIENT_CREDITS_CODE = -32002;

export interface BridgeResponse {
  jsonrpc: "2.0";
  id?: string | number;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

type AgentRuntimeHealthPayload = {
  ready?: unknown;
  runtime?: unknown;
  database?: unknown;
  plugins?: { failed?: unknown } | null;
  agentState?: unknown;
  startup?: { lastError?: unknown } | null;
};

export interface SnapshotResult {
  success: boolean;
  backup?: AgentSandboxBackup;
  error?: string;
}

/**
 * Sentinel error for "the running agent image does not serve POST /api/snapshot".
 * The deployed elizaOS (V2) agent image binds its API to ELIZA_PORT/PORT and
 * does not expose the bridge `/api/snapshot` route — only the cloud-agent
 * template image (and the in-memory test double) do. A scheduled (auto) backup
 * against such an agent is a no-op, not a failure, so the snapshot job treats
 * this exactly like "Sandbox is not running": skip without burning retries.
 */
export const SNAPSHOT_ENDPOINT_UNSUPPORTED = "Snapshot endpoint not supported by agent image";

const MAX_BACKUPS = 10;
const SHARED_RUNTIME_HISTORY_MAX_MESSAGES = 40;
// Heartbeat probes the agent over the headscale tailnet. When idle the path
// goes cold, so the first probe after a quiet period can fail while it
// re-establishes — retry before evicting a healthy agent.
const HEARTBEAT_PROBE_ATTEMPTS = 3;
const HEARTBEAT_PROBE_RETRY_MS = 2_000;
// A single failed cycle must not evict. Only mark disconnected after the agent
// has been continuously unreachable this long — last_heartbeat_at (bumped only
// on success) is the downtime clock. The ~30s heartbeat itself keeps the
// WireGuard NAT mapping warm, so a reachable agent never trips this.
const HEARTBEAT_DISCONNECT_AFTER_MS = 120_000;
// IP reconciliation (heartbeat + recovery): agent containers do not persist
// tailscale node state, so a container restart mints a fresh node key and
// headscale hands out the NEXT sequential IP — the stored headscale_ip /
// bridge_url go stale while the container itself is healthy. Every consumer
// reads those stored columns (the heartbeat probe, the agent-router's
// subdomain resolution, and therefore the public dedicated-agent proxy), so
// the heal must REPAIR the columns, not tolerate the miss.
const RECONCILE_SSH_CMD_TIMEOUT_MS = 15_000;
// Cap on consecutive heartbeat cycles a docker-healthy container may stay
// `running` while its current tailnet IP cannot be resolved (node SSH down,
// docker exec failing). Each such cycle ratchets error_count; hitting the cap
// escalates to `disconnected` so the recovery cycle's reprovision self-heal
// still fires — an unreachable paid agent must never look "running" forever.
const IP_RECONCILE_MAX_UNRESOLVED_CYCLES = 3;
const SNAPSHOT_FETCH_TIMEOUT_MS = 120_000;
const SNAPSHOT_RESTORE_TIMEOUT_MS = 120_000;
const UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS = 30_000;
// Hard cap on the container+VPN teardown during agent delete. The underlying
// docker rm (60s) and headscale deletion (15s) are each internally bounded, but
// an EARLY hang (SSH connect / provider init) was not — and a single stuck node
// could then hang the delete past the 300s job watchdog and wedge the whole
// provisioning worker. Generous over the internal caps, well under the watchdog.
const SANDBOX_DELETE_STOP_TIMEOUT_MS = 120_000;
type LifecycleTx = Parameters<Parameters<Database["transaction"]>[0]>[0];

/** Columns the tailnet-IP reconcile path reads to locate and repair an agent. */
type ReconcilableSandbox = Pick<
  AgentSandbox,
  "id" | "node_id" | "container_name" | "environment_vars" | "bridge_url" | "headscale_ip"
>;

/** Outcome of a stale-tailnet-IP reconcile attempt (see reconcileStaleTailnetIp). */
type TailnetIpReconcileResult =
  | { outcome: "repaired"; headscaleIp: string; bridgeUrl: string }
  | { outcome: "container-dead" }
  | { outcome: "ip-unresolvable" }
  | { outcome: "unrepairable" };

function digestPinnedImageRef(imageRef: string, digest: string): string {
  if (imageRef.includes("@sha256:")) return imageRef;
  const lastColon = imageRef.lastIndexOf(":");
  const lastSlash = imageRef.lastIndexOf("/");
  const withoutTag = lastColon > lastSlash ? imageRef.slice(0, lastColon) : imageRef;
  return `${withoutTag}@${digest}`;
}

function isDockerSandboxMetadata(value: unknown): value is DockerSandboxMetadata {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "docker" &&
    typeof (value as { nodeId?: unknown }).nodeId === "string" &&
    typeof (value as { hostname?: unknown }).hostname === "string" &&
    typeof (value as { containerName?: unknown }).containerName === "string"
  );
}

/**
 * True when a provider handle's metadata self-identifies as the real docker
 * fleet provider (`provider: "docker"`) — REGARDLESS of whether the rest of the
 * shape passes {@link isDockerSandboxMetadata}. This is deliberately laxer than
 * the full type guard: a docker-fleet container whose metadata drifts (a missing
 * field, an empty-string nodeId) still IS docker-backed and still occupies a
 * real node slot, even though the strict guard would reject it.
 *
 * Used to detect the C1b failure class (audit §C1b): a handle that is docker-
 * backed but for which we cannot recover a usable node_id. Such a row MUST NOT
 * be flipped to `running` (it would be an unattributable orphan the recount
 * undercounts and the orphan reconciler provably cannot reap — audit §C5).
 *
 * Non-docker providers (`local-docker`, `memory`) return false: they have no
 * node concept, so the attribution guard does not apply to them.
 */
function isDockerBackedMetadata(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { provider?: unknown }).provider === "docker"
  );
}

/**
 * Distinguishable prefix for the C1b attribution-guard failure. Chosen so it can
 * NEVER collide with the port-collision retry classifier in provision()'s catch
 * (which matches "23505" / "unique" / "duplicate") — metadata drift is a
 * permanent-ish condition, so this failure must classify as NON-retryable and
 * fall through to markError, not spin the retry loop.
 */
const PROVISION_ATTRIBUTION_GUARD_PREFIX = "provision attribution guard:";

type RuntimeAgentSummary = {
  id?: string;
  name?: string;
  status?: string;
};

type RuntimeAgentListResult = {
  supported: boolean;
  agents: RuntimeAgentSummary[];
};

const DEFAULT_CENTRAL_SERVER_ID = "00000000-0000-0000-0000-000000000000";

class BridgeRouteUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "BridgeRouteUnavailableError";
  }
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

// HTTP statuses that make a snapshot fetch/restore fail for THIS snapshot in a
// way the current provision cannot retry away, so it must degrade to a fresh
// boot instead of bricking the agent (#15210): 401/403 (auth — a dead/rotated
// container or an unauthenticated/rotating token rejects every retry
// identically), 404 (endpoint or snapshot gone), 410 (gone). Everything else —
// 5xx, 408/429, network/timeout — can heal on a retry and must NOT appear here.
const UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES = new Set([401, 403, 404, 410]);
// The subset that is also PERMANENTLY LOST — the snapshot itself is gone and no
// later resume can restore it, so the dead backup chain should be pruned: 404
// (endpoint or snapshot gone) and 410 (gone). 401/403 are auth failures, which
// are RECOVERABLE (missing/rotating token — see #15263, where the incident 401
// was a healthy container whose restore push simply omitted the agent token),
// so they must degrade-but-PRESERVE the chain: never prune a snapshot a
// token-corrected resume could still restore (#15274).
const PERMANENTLY_LOST_SNAPSHOT_HTTP_STATUSES = new Set([404, 410]);
// Anchored on the exact `fetchSnapshotState` / `pushState` throw shapes so only
// this file's snapshot HTTP throw sites classify — an unrelated error that
// merely embeds one of these strings does not.
const SNAPSHOT_HTTP_ERROR_SHAPE =
  /^(?:Snapshot fetch failed|State restore failed): HTTP (\d{3})(?:\s|$)/;

/**
 * True only when a stored backup snapshot can never be applied, no matter how
 * many times the provision retries. An agent's identity, config, and durable
 * data live in the DB record; a snapshot holds only volatile in-memory session
 * state — so the designed degrade for an unrecoverable snapshot (#15210) is
 * "boot fresh, lose only the volatile session", never "brick the whole agent".
 * Two shapes qualify:
 *
 * - UNDECRYPTABLE: the AEAD auth tag fails to verify (corruption / wrong key /
 *   wrong AAD, surfaced by `@elizaos/security` as `AeadError`) or the KMS key
 *   version that encrypted it no longer exists (`KeyNotFoundError` — thrown
 *   only by the ephemeral `memory` KMS backend, which derives a fresh
 *   per-process key on every restart and thus orphans everything it previously
 *   encrypted). Matched by error class NAME rather than `instanceof` because
 *   `AeadError` is internal to `@elizaos/security` (not exported) and this code
 *   runs bundled, where a cross-realm `instanceof` on a dependency's error
 *   class is unreliable.
 * - UNRETRIEVABLE / UNRESTORABLE: the snapshot fetch or restore push was
 *   rejected with an unrecoverable-for-this-provision HTTP status (see
 *   `UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES`). The incident shape (HQ 14308, agent
 *   23766030): `State restore failed: HTTP 401 {"error":"Unauthorized"}` from a
 *   bridge URL — deterministic on every attempt of THIS provision, so retrying
 *   only re-failed it into status=error.
 *
 * Deliberately NARROW so it never swallows a recoverable failure: HTTP 5xx /
 * 408 / 429, network/timeout errors, a transient KMS error (the Steward
 * backend surfaces HTTP 5xx as a base `KmsError`, not `KeyNotFoundError`), and
 * DB/IO errors are NOT matched and still propagate — degrading on one of those
 * would silently discard state that a retry would have restored.
 *
 * NOTE: "unrecoverable for this provision" (boot fresh) is a strictly WIDER
 * classification than "permanently lost" (also prune the chain). A 401/403 is
 * unrecoverable here but the snapshot is NOT permanently lost — an auth failure
 * heals once the token is attached/rotated correctly (#15263), so
 * `isPermanentlyLostSnapshot` must gate any pruning, never this predicate.
 */
export function isUnrecoverableSnapshotError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AeadError" || error.name === "KeyNotFoundError") return true;
  const match = SNAPSHOT_HTTP_ERROR_SHAPE.exec(error.message);
  return match !== null && UNRECOVERABLE_SNAPSHOT_HTTP_STATUSES.has(Number(match[1]));
}

/**
 * True only when the snapshot is PERMANENTLY LOST — no later resume, on any
 * container with any token, can ever restore it — so the dead backup chain is
 * safe to prune. A strict SUBSET of `isUnrecoverableSnapshotError`:
 *
 * - The crypto shapes (`AeadError` / `KeyNotFoundError`): the bytes can never
 *   be decrypted again (corruption, or the ephemeral `memory` KMS key that
 *   encrypted them is gone), so the chain is genuinely dead.
 * - HTTP 404 (endpoint or snapshot gone) / 410 (gone): the snapshot resource
 *   itself no longer exists to fetch.
 *
 * Excludes 401/403: those are AUTH failures (missing/rotating token), which are
 * RECOVERABLE — pruning on one would silently, permanently discard a snapshot a
 * token-corrected resume could still restore (#15274 regression class). On an
 * auth failure we still degrade to a fresh boot (never brick), but we PRESERVE
 * the chain and let the next authenticated resume restore it.
 */
export function isPermanentlyLostSnapshot(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "AeadError" || error.name === "KeyNotFoundError") return true;
  const match = SNAPSHOT_HTTP_ERROR_SHAPE.exec(error.message);
  return match !== null && PERMANENTLY_LOST_SNAPSHOT_HTTP_STATUSES.has(Number(match[1]));
}

export class ElizaSandboxService {
  private _provider?: SandboxProvider;
  private _providerPromise?: Promise<SandboxProvider>;

  constructor(provider?: SandboxProvider) {
    if (provider) {
      this._provider = provider;
    }
  }

  private async getProvider(): Promise<SandboxProvider> {
    if (this._provider) return this._provider;
    if (!this._providerPromise) {
      this._providerPromise = createSandboxProvider().then((p) => {
        this._provider = p;
        return p;
      });
    }
    return this._providerPromise;
  }

  private getAgentApiToken(rec: Pick<AgentSandbox, "id" | "environment_vars">): string | undefined {
    const envVars = rec.environment_vars as Record<string, string> | null;
    const apiToken =
      envVars?.ELIZA_API_TOKEN?.trim() ||
      envVars?.ELIZAOS_API_KEY?.trim() ||
      envVars?.ELIZAOS_CLOUD_API_KEY?.trim();
    if (!apiToken) {
      logger.warn("[agent-sandbox] No API token for agent proxy", {
        agentId: rec.id,
      });
      return undefined;
    }
    return apiToken;
  }

  private getAgentJsonHeaders(rec: Pick<AgentSandbox, "id" | "environment_vars">) {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiToken = this.getAgentApiToken(rec);
    if (apiToken) {
      headers.Authorization = `Bearer ${apiToken}`;
      headers["X-Api-Key"] = apiToken;
      headers["X-Eliza-Token"] = apiToken;
    }
    return headers;
  }

  private getRuntimeAgentsFromBody(body: unknown): RuntimeAgentSummary[] {
    const root = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const data =
      root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
    const rawAgents = Array.isArray(root.agents)
      ? root.agents
      : Array.isArray(data.agents)
        ? data.agents
        : [];

    return rawAgents
      .map((item): RuntimeAgentSummary | null => {
        if (!item || typeof item !== "object") return null;
        const agent = item as Record<string, unknown>;
        return {
          id: typeof agent.id === "string" ? agent.id : undefined,
          name:
            typeof agent.name === "string"
              ? agent.name
              : typeof agent.characterName === "string"
                ? agent.characterName
                : undefined,
          status: typeof agent.status === "string" ? agent.status : undefined,
        };
      })
      .filter((agent): agent is RuntimeAgentSummary => Boolean(agent?.id || agent?.name));
  }

  private isRuntimeAgentReady(agent: RuntimeAgentSummary | undefined): boolean {
    if (!agent) return false;
    const status = agent.status?.toLowerCase();
    return status === "active" || status === "running" || status === "ready";
  }

  private selectRuntimeAgent(agents: RuntimeAgentSummary[]): RuntimeAgentSummary | undefined {
    return agents.find((agent) => this.isRuntimeAgentReady(agent)) ?? agents[0];
  }

  private async listRuntimeAgents(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
  ): Promise<RuntimeAgentListResult> {
    const agentsEndpoint = await this.getAgentApiEndpoint(rec, "/api/agents");
    const agentsRes = await fetch(agentsEndpoint, {
      method: "GET",
      headers: this.getAgentJsonHeaders(rec),
      signal: AbortSignal.timeout(10_000),
    });
    if (agentsRes.status === 404) {
      return { supported: false, agents: [] };
    }
    if (!agentsRes.ok) {
      throw new Error(`Runtime agent list returned HTTP ${agentsRes.status}`);
    }
    return {
      supported: true,
      agents: this.getRuntimeAgentsFromBody(await agentsRes.json().catch(() => ({}))),
    };
  }

  private buildRuntimeBootstrapAgent(
    rec: Pick<AgentSandbox, "id" | "agent_name" | "agent_config" | "environment_vars">,
  ) {
    const rawConfig =
      rec.agent_config && typeof rec.agent_config === "object" && !Array.isArray(rec.agent_config)
        ? ({ ...(rec.agent_config as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const rawName =
      typeof rawConfig.name === "string" && rawConfig.name.trim()
        ? rawConfig.name.trim()
        : rec.agent_name?.trim() || `Cloud Agent ${rec.id.slice(0, 8)}`;
    const plugins =
      Array.isArray(rawConfig.plugins) && rawConfig.plugins.length > 0
        ? rawConfig.plugins
        : ["@elizaos/plugin-sql", "@elizaos/plugin-elizacloud"];
    const rawSettings =
      rawConfig.settings &&
      typeof rawConfig.settings === "object" &&
      !Array.isArray(rawConfig.settings)
        ? ({ ...(rawConfig.settings as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const rawSecrets =
      rawSettings.secrets &&
      typeof rawSettings.secrets === "object" &&
      !Array.isArray(rawSettings.secrets)
        ? ({ ...(rawSettings.secrets as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    const environmentVars =
      rec.environment_vars && typeof rec.environment_vars === "object"
        ? (rec.environment_vars as Record<string, string>)
        : {};
    const secrets = mergeRuntimeAgentSecretsFromEnv({ rawSecrets, environmentVars });
    const settings = {
      ...rawSettings,
      secrets,
    };

    return {
      ...rawConfig,
      name: rawName,
      username:
        typeof rawConfig.username === "string" && rawConfig.username.trim()
          ? rawConfig.username.trim()
          : rawName
              .toLowerCase()
              .replace(/[^a-z0-9]+/g, "-")
              .replace(/^-+|-+$/g, "") || "cloud-agent",
      // A dedicated agent is created with only a name (no persona is collected
      // at creation time), so without a real identity "what is your name" gets a
      // generic deflection. Seed a name-aware identity — mirroring
      // buildSharedRuntimeCharacter — so the runtime boots with a real system
      // prompt without claiming to be a differently-named character.
      system:
        typeof rawConfig.system === "string" && rawConfig.system.trim()
          ? rawConfig.system
          : `You are ${rawName}, a helpful assistant.`,
      bio:
        Array.isArray(rawConfig.bio) && rawConfig.bio.length > 0
          ? rawConfig.bio
          : [`${rawName} is a helpful Eliza Cloud agent.`],
      topics:
        Array.isArray(rawConfig.topics) && rawConfig.topics.length > 0 ? rawConfig.topics : [],
      adjectives:
        Array.isArray(rawConfig.adjectives) && rawConfig.adjectives.length > 0
          ? rawConfig.adjectives
          : [],
      style:
        rawConfig.style && typeof rawConfig.style === "object" && !Array.isArray(rawConfig.style)
          ? rawConfig.style
          : undefined,
      plugins,
      settings,
    };
  }

  private async startRuntimeAgent(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    runtimeAgentId: string,
  ): Promise<void> {
    const startEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/agents/${encodeURIComponent(runtimeAgentId)}/start`,
    );
    const startRes = await fetch(startEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      signal: AbortSignal.timeout(60_000),
    });
    if (!startRes.ok) {
      throw new Error(`Runtime agent start returned HTTP ${startRes.status}`);
    }
  }

  private async createRuntimeAgent(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "organization_id"
      | "user_id"
    >,
  ): Promise<string> {
    const createEndpoint = await this.getAgentApiEndpoint(rec, "/api/agents");
    // Bootstrap secrets (OPENAI_API_KEY / ANTHROPIC_API_KEY / ...) are copied
    // out of environment_vars, which stores them encrypted at rest (#11332) —
    // materialize real values before building the bootstrap payload.
    const bootstrapEnv = await decryptAgentEnvVars(
      (rec.environment_vars as Record<string, string> | null) ?? {},
    );
    // Team credential pool (#11332): providers the agent has NO key for are
    // filled from the org's pooled credentials. Merged only into this
    // in-memory bootstrap payload (→ settings.secrets via
    // buildRuntimeBootstrapAgent) — never persisted to environment_vars.
    // A provider with no eligible pooled credential leaves the env unchanged
    // (the registry degrades a missing/unhealthy pool to null, its J4); a
    // genuine internal pool fault propagates and fails provisioning closed —
    // consistent with the decrypt/create throws above — rather than silently
    // booting an agent missing a credential it was meant to receive.
    const pooledEnv = await applyPooledCredentialsToBootstrapEnv({
      organizationId: rec.organization_id,
      userId: rec.user_id,
      sessionKey: rec.id,
      env: bootstrapEnv,
    });
    const createRes = await fetch(createEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify({
        agent: this.buildRuntimeBootstrapAgent({ ...rec, environment_vars: pooledEnv }),
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!createRes.ok) {
      throw new Error(`Runtime agent create returned HTTP ${createRes.status}`);
    }

    const body = (await createRes.json().catch(() => ({}))) as Record<string, unknown>;
    const data =
      body.data && typeof body.data === "object" ? (body.data as Record<string, unknown>) : {};
    const runtimeAgentId = typeof data.id === "string" ? data.id : undefined;
    if (!runtimeAgentId) {
      throw new Error("Runtime agent create response was missing data.id");
    }
    return runtimeAgentId;
  }

  private async ensureRuntimeAgentStarted(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "agent_name"
      | "agent_config"
      | "environment_vars"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "organization_id"
      | "user_id"
    >,
  ): Promise<RuntimeAgentSummary | null> {
    const initial = await this.listRuntimeAgents(rec);
    if (!initial.supported) return null;

    const existing = this.selectRuntimeAgent(initial.agents);
    if (this.isRuntimeAgentReady(existing)) return existing ?? null;

    const runtimeAgentId = existing?.id ?? (await this.createRuntimeAgent(rec));
    await this.startRuntimeAgent(rec, runtimeAgentId);

    const afterStart = await this.listRuntimeAgents(rec);
    const started =
      afterStart.agents.find((agent) => agent.id === runtimeAgentId) ?? afterStart.agents[0];
    if (!this.isRuntimeAgentReady(started)) {
      throw new Error("Runtime agent did not become active after start");
    }
    return started;
  }

  private stableBridgeUuid(raw: string): string {
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) {
      return raw;
    }
    const hash = crypto.createHash("sha256").update(raw).digest("hex");
    return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(
      17,
      20,
    )}-${hash.slice(20, 32)}`;
  }

  private stableBridgeUserId(params: Record<string, unknown>): string {
    const raw =
      typeof params.userId === "string" && params.userId.trim()
        ? params.userId.trim()
        : typeof params.roomId === "string" && params.roomId.trim()
          ? params.roomId.trim()
          : "cloud-user";
    return this.stableBridgeUuid(raw);
  }

  private stableBridgeChannelId(agentId: string, params: Record<string, unknown>): string {
    const raw =
      typeof params.roomId === "string" && params.roomId.trim()
        ? params.roomId.trim()
        : typeof params.userId === "string" && params.userId.trim()
          ? params.userId.trim()
          : "default";
    return this.stableBridgeUuid(`cloud-bridge-channel:${agentId}:${raw}`);
  }

  // Agent CRUD

  private buildAgentInsertData(params: CreateAgentParams): NewAgentSandbox {
    const sanitizedConfig = stripReservedElizaConfigKeys(params.agentConfig);
    const agentConfig = params.characterId
      ? withReusedElizaCharacterOwnership(sanitizedConfig)
      : sanitizedConfig;

    const executionTier: AgentExecutionTier = params.executionTier ?? "shared";
    const status = executionTier === "shared" ? "running" : "pending";

    return {
      organization_id: params.organizationId,
      user_id: params.userId,
      agent_name: params.agentName,
      agent_config: agentConfig,
      environment_vars: params.environmentVars ?? {},
      status,
      execution_tier: executionTier,
      database_status: "none",
      ...(params.characterId && { character_id: params.characterId }),
      ...(params.dockerImage && { docker_image: params.dockerImage }),
    };
  }

  /**
   * Enforce `maxNonTerminalAgents` for an org: count its quota-holding
   * ({@link QUOTA_COUNTED_STATUSES}), non-pool sandboxes and throw
   * {@link AgentQuotaExceededError} at/past the cap. MUST run inside a
   * transaction that already holds the org's agent-create advisory lock so
   * the count→insert is atomic — two concurrent creates can't both read
   * `count = max-1` and both insert.
   */
  private async assertOrgAgentQuota(
    tx: LifecycleTx,
    organizationId: string,
    cap: number,
  ): Promise<void> {
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

  async createAgent(params: CreateAgentParams): Promise<{
    agent: AgentSandbox;
    idempotent: boolean;
  }> {
    // SECURITY (H1, #12230): gate a caller-supplied image against the managed-
    // agent allowlist BEFORE any DB write or provisioning. Throws
    // AgentImageNotAllowedError (→ 4xx at the route) so a non-allowlisted image
    // provisions nothing. Runs for EVERY createAgent caller — the gate lives in
    // the shared service path, not per-route.
    assertAgentImageAllowed(params.dockerImage);

    logger.info("[agent-sandbox] Creating agent", {
      orgId: params.organizationId,
      name: params.agentName,
      reuse: params.reuseExistingNonTerminal ?? false,
    });

    // Caller-supplied env can carry BYO secrets — encrypt them before the row
    // is inserted (#11332), mirroring updateAgentEnvironment.
    if (params.environmentVars && Object.keys(params.environmentVars).length > 0) {
      params = {
        ...params,
        environmentVars: await encryptAgentEnvVarsForStorage(
          params.organizationId,
          params.environmentVars,
        ),
      };
    }

    // Multi-agent-per-org callers (waifu launches, compat) leave the flag unset
    // and keep the plain insert — they legitimately mint several agents per org.
    if (!params.reuseExistingNonTerminal) {
      // Uncapped fast path for trusted internal multi-agent callers.
      if (params.maxNonTerminalAgents === undefined) {
        const created = await agentSandboxesRepository.create(this.buildAgentInsertData(params));
        return { agent: created, idempotent: false };
      }

      // Capped path (#11023): a user-facing forceCreate that bypasses the reuse
      // guard must still not mint unbounded dedicated containers. Count the org's
      // quota-holding sandboxes UNDER the same org advisory lock the reuse guard
      // uses and refuse past the cap.
      const cap = params.maxNonTerminalAgents;
      return dbWrite.transaction(async (tx) => {
        await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));
        await this.assertOrgAgentQuota(tx, params.organizationId, cap);

        const [created] = await tx
          .insert(agentSandboxes)
          .values(this.buildAgentInsertData(params))
          .returning();
        if (!created) throw new Error("Failed to create agent record");
        return { agent: created, idempotent: false };
      });
    }

    // Mirrors createCodingContainerAgent: an org-scoped advisory lock + a
    // FOR UPDATE reuse guard serialize concurrent creates so a retry / SDK
    // double-call / provision flap can't strand the org with N agents (each =
    // a container + per-tenant DB + ingress).
    return dbWrite.transaction(async (tx) => {
      await tx.execute(elizaAgentCreateAdvisoryLockSql(params.organizationId));

      const [existing] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, params.organizationId),
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.status} IN ('pending', 'provisioning', 'running')`,
          ),
        )
        .orderBy(desc(agentSandboxes.created_at))
        .for("update")
        .limit(1);

      if (existing) {
        return { agent: existing, idempotent: true };
      }

      // The guard above only hands back a LIVE agent — a `stopped`/`sleeping`
      // one must be resumed/woken, not reused — so after a suspend there is
      // nothing to collapse onto and control falls through to a fresh insert.
      // Without a cap that insert is unbounded: a create→suspend→create loop
      // mints a new agent (each = a per-tenant managed DB) every iteration
      // (#11023 residual). Enforce the same per-org ceiling, still under the
      // org advisory lock.
      if (params.maxNonTerminalAgents !== undefined) {
        await this.assertOrgAgentQuota(tx, params.organizationId, params.maxNonTerminalAgents);
      }

      const [created] = await tx
        .insert(agentSandboxes)
        .values(this.buildAgentInsertData(params))
        .returning();
      if (!created) throw new Error("Failed to create agent record");
      return { agent: created, idempotent: false };
    });
  }

  async createCodingContainerAgent(params: CreateAgentParams & { dockerImage: string }): Promise<{
    agent: AgentSandbox;
    idempotent: boolean;
  }> {
    const createParams: CreateAgentParams & { dockerImage: string } = {
      ...params,
      executionTier: params.executionTier ?? "custom",
      // Coding-container env carries caller secrets (tokens, provider keys) —
      // encrypt them before the row is inserted (#11332).
      environmentVars: params.environmentVars
        ? await encryptAgentEnvVarsForStorage(params.organizationId, params.environmentVars)
        : params.environmentVars,
    };

    logger.info("[agent-sandbox] Creating coding-container agent", {
      orgId: createParams.organizationId,
      name: createParams.agentName,
      image: createParams.dockerImage,
    });

    return dbWrite.transaction(async (tx) => {
      // Acquire the per-ORG agent-create lock BEFORE the per-image lock. The
      // image lock alone (keyed on the exact docker_image) does NOT serialize
      // two concurrent creates for DIFFERENT images against one org, so the
      // quota count below would not be atomic without the org lock. Taking the
      // org lock first everywhere gives a strict org→image lock order, so this
      // path and createAgent (org lock only) can never deadlock. (#11023)
      await tx.execute(elizaAgentCreateAdvisoryLockSql(createParams.organizationId));
      await tx.execute(
        elizaCodingContainerImageAdvisoryLockSql(
          createParams.organizationId,
          createParams.dockerImage,
        ),
      );

      const [existing] = await tx
        .select()
        .from(agentSandboxes)
        .where(
          and(
            eq(agentSandboxes.organization_id, createParams.organizationId),
            eq(agentSandboxes.docker_image, createParams.dockerImage),
            sql`${agentSandboxes.pool_status} IS NULL`,
            sql`${agentSandboxes.status} IN ('pending', 'provisioning', 'running')`,
          ),
        )
        .orderBy(desc(agentSandboxes.created_at))
        .for("update")
        .limit(1);

      if (existing) {
        return { agent: existing, idempotent: true };
      }

      // Per-org quota (#11023): the per-image reuse guard collapses only
      // same-image retries, so a distinct-image loop (`:v1`/`:v2`/`@sha256…`
      // under an allowlisted namespace) would otherwise mint unbounded custom
      // containers on the shared fleet. #11042 capped createAgent's plain-insert
      // branch but not this route; enforce the SAME per-org ceiling here, under
      // the org lock so the count→insert is atomic against concurrent creates.
      // Trusted internal callers pass no cap and stay uncapped.
      if (createParams.maxNonTerminalAgents !== undefined) {
        await this.assertOrgAgentQuota(
          tx,
          createParams.organizationId,
          createParams.maxNonTerminalAgents,
        );
      }

      const [created] = await tx
        .insert(agentSandboxes)
        .values(this.buildAgentInsertData(createParams))
        .returning();
      if (!created) throw new Error("Failed to create coding-container agent record");
      return { agent: created, idempotent: false };
    });
  }

  async getAgent(agentId: string, orgId: string) {
    return agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
  }

  async getAgentById(agentId: string) {
    return agentSandboxesRepository.findById(agentId);
  }

  async updateAgentEnvironment(
    agentId: string,
    orgId: string,
    environmentVars: Record<string, string>,
  ): Promise<AgentSandbox | undefined> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec) return undefined;
    // BYO secrets (provider API keys, tokens) are encrypted at rest (#11332);
    // the materialization paths (provision / fleet upgrade / runtime
    // bootstrap) decrypt, so the running agent still sees real values.
    return agentSandboxesRepository.update(rec.id, {
      environment_vars: await encryptAgentEnvVarsForStorage(orgId, environmentVars),
    });
  }

  /**
   * Edit an agent's profile in place — its display name and/or its persisted
   * `agent_config` (system prompt / character fields). `agentConfig` is merged
   * into the existing config so a partial edit never drops other keys. A name
   * edit applies immediately (cloud agent name + shared-runtime character);
   * dedicated-container config edits take effect on the next provision/restart.
   */
  async updateAgentProfile(
    agentId: string,
    orgId: string,
    input: { agentName?: string; agentConfig?: Record<string, unknown> },
  ): Promise<AgentSandbox | undefined> {
    const rec = await agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
    if (!rec) return undefined;

    const updates: { agent_name?: string; agent_config?: Record<string, unknown> } = {};
    if (input.agentName !== undefined) updates.agent_name = input.agentName;
    if (input.agentConfig !== undefined) {
      const existing =
        rec.agent_config && typeof rec.agent_config === "object" && !Array.isArray(rec.agent_config)
          ? (rec.agent_config as Record<string, unknown>)
          : {};
      updates.agent_config = { ...existing, ...input.agentConfig };
    }
    if (Object.keys(updates).length === 0) return rec;

    return agentSandboxesRepository.update(rec.id, updates);
  }

  async getAgentForWrite(agentId: string, orgId: string) {
    return agentSandboxesRepository.findByIdAndOrgForWrite(agentId, orgId);
  }

  async listAgents(orgId: string) {
    return agentSandboxesRepository.listByOrganization(orgId);
  }

  async deleteAgent(agentId: string, orgId: string): Promise<DeleteAgentResult> {
    // Phase 1 — short transaction: take the lifecycle lock, validate
    // preconditions, and capture the fields needed for teardown. We deliberately
    // do NOT run the container teardown inside this transaction: provider.stop()
    // can hang on an early SSH connect / provider init, and holding the row lock
    // + write transaction + a pooled connection for the full teardown cap (up to
    // SANDBOX_DELETE_STOP_TIMEOUT_MS) would wedge concurrent lifecycle ops on the
    // same agent/org. The lock + transaction are released the moment this returns.
    const precheck = await this.prepareAgentDelete(agentId, orgId);

    if (!precheck.ok) {
      return { success: false, error: precheck.error };
    }

    logger.info("[agent-sandbox] Deleting agent", {
      agentId,
      sandbox: precheck.sandboxId,
    });

    // Phase 2 — bounded container + VPN teardown, run OUTSIDE the write-lock /
    // transaction. provider.stop() removes the container and cleans up the
    // headscale route (each internally bounded), but an EARLY hang (SSH connect /
    // provider init) was unbounded — a single stuck node could hang this delete
    // past the 300s job watchdog and wedge the entire provisioning worker
    // (fail-closed on every provision).
    //
    // Provider errors are captured as values so `withTimeout` rejects ONLY on a
    // genuine hang. A real stop failure on a REACHABLE node still escalates
    // (returns failure / retry), since the container may still be running; an
    // "already gone" failure is ignorable and we proceed.
    if (precheck.sandboxId) {
      const sandboxId = precheck.sandboxId;
      const stop = await this.runBoundedSandboxStop(sandboxId);

      if (stop) {
        const errorMessage = stop.error instanceof Error ? stop.error.message : String(stop.error);
        if ("timedOut" in stop) {
          // HONEST LIMITATION: there is currently NO automatic reclaimer — no
          // orphan-sweep / node-reconcile job that lists actual containers on a
          // node and removes ones with no DB row (see docker-sandbox-provider's
          // unreachable-node path for the same trade-off). We complete the
          // delete to keep the provisioning work cycle bounded, but on timeout
          // the container (and its headscale registration) is ABANDONED and will
          // LEAK until such a sweeper is built or it is reclaimed by hand. Do NOT
          // claim a reconciler already reclaims it.
          logger.warn(
            "[agent-sandbox] Stop during delete timed out; completing delete and ABANDONING the " +
              "container — it will LEAK until reclaimed (no automatic orphan-sweep / node-reconcile " +
              "job exists yet)",
            { sandboxId, status: precheck.status, error: errorMessage },
          );
        } else if (this.isIgnorableSandboxStopError(stop.error)) {
          logger.info("[agent-sandbox] Sandbox already absent during delete cleanup", {
            sandboxId,
            status: precheck.status,
            error: errorMessage,
          });
        } else {
          logger.warn("[agent-sandbox] Stop failed during delete", {
            sandboxId,
            status: precheck.status,
            error: errorMessage,
          });
          return { success: false, error: "Failed to delete sandbox" };
        }
      }
    }

    // Phase 3 — short transaction: re-take the lock, re-validate (a concurrent
    // provision could have started while teardown ran), then delete the row.
    const result = await this.commitAgentRowDelete(agentId, orgId);

    if (result.success) {
      // Best-effort: revoke the per-agent API key after the row delete commits.
      // A failure here does not un-delete the sandbox; the key just lingers as
      // inactive data and can be cleaned by ops.
      try {
        await apiKeysService.revokeForAgent(agentId);
      } catch (err) {
        logger.warn("[agent-sandbox] Failed to revoke per-agent API key", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      // Best-effort: drop the shared-runtime (Tier-0) conversation history for
      // this agent. That table is deliberately decoupled from the sandbox row
      // (no FK cascade), so the per-channel history rows would otherwise be
      // orphaned forever after the agent is gone. A failure here leaves stale
      // rows but never un-deletes the (already gone) sandbox.
      try {
        const removed = await sharedRuntimeHistoryRepository.deleteByAgent(agentId);
        if (removed > 0) {
          logger.info("[agent-sandbox] Cleaned up shared-runtime history after delete", {
            agentId,
            channelsRemoved: removed,
          });
        }
      } catch (err) {
        logger.warn("[agent-sandbox] Failed to clean up shared-runtime history", {
          agentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return result;
  }

  /**
   * Phase 1 of `deleteAgent` (see there): short write transaction that takes
   * the lifecycle lock, validates delete preconditions, and captures the
   * sandbox id + status for the (out-of-transaction) teardown. Kept separate so
   * the lock/transaction is held only for these quick DB ops, never across the
   * bounded container teardown.
   */
  private async prepareAgentDelete(
    agentId: string,
    orgId: string,
  ): Promise<
    | { ok: true; sandboxId: string | null; status: AgentSandbox["status"] }
    | { ok: false; error: string }
  > {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { ok: false as const, error: "Agent not found" };

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return { ok: false as const, error: "Agent provisioning is in progress" };
      }

      return { ok: true as const, sandboxId: rec.sandbox_id, status: rec.status };
    });
  }

  /**
   * Phase 3 of `deleteAgent` (see there): short write transaction that re-takes
   * the lifecycle lock, re-validates (a concurrent provision could have started
   * while the out-of-transaction teardown ran), then deletes the sandbox row.
   */
  private async commitAgentRowDelete(agentId: string, orgId: string): Promise<DeleteAgentResult> {
    return dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return {
          success: false,
          error: "Agent provisioning is in progress",
        } as const;
      }

      const deleted = await tx.execute<AgentSandbox>(sql`
        DELETE FROM ${agentSandboxes}
        WHERE id = ${agentId}
          AND organization_id = ${orgId}
        RETURNING *
      `);
      const deletedSandbox = deleted.rows[0];

      return deletedSandbox
        ? ({ success: true, deletedSandbox } as const)
        : ({ success: false, error: "Agent not found" } as const);
    });
  }

  /**
   * Phase 2 of `deleteAgent` (see there): the bounded container + VPN teardown.
   * Provider errors are captured as values so `withTimeout` rejects ONLY on a
   * genuine hang. Returns `null` on success, `{ error }` on a bounded failure,
   * or `{ error, timedOut: true }` when the teardown hit the hard cap (in which
   * case the container is abandoned and leaks — there is no reclaimer).
   */
  private async runBoundedSandboxStop(sandboxId: string): Promise<BoundedSandboxStopResult> {
    return withTimeout(
      (async (): Promise<null | { error: unknown }> => {
        try {
          const provider = await this.getProvider();
          await provider.stop(sandboxId);
          return null;
        } catch (error) {
          return { error };
        }
      })(),
      SANDBOX_DELETE_STOP_TIMEOUT_MS,
      `agent-delete stop ${sandboxId}`,
    ).catch((error: unknown) => ({ error, timedOut: true as const }));
  }

  /**
   * Async-path counterpart to `deleteAgent`, invoked by the provisioning
   * worker daemon when it picks up an `agent_delete` job. Returns a
   * structured outcome the daemon stores in the job result so observers can
   * tell apart "container survived stop" (ops needed) from "row delete
   * failed" (probably retried by next attempt).
   *
   * Wraps `deleteAgent` so the SSH/DB sequence stays in one place,
   * but maps the return shape to what the queue handler expects and
   * tracks whether the container actually went down before the row was
   * removed. The row delete happens iff `stop` either succeeded or the
   * container was already gone — both are observable in the `deleteAgent`
   * success path (`isIgnorableSandboxStopError` swallows "no such
   * container" specifically).
   */
  async executeDeletion(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerStopped: boolean;
    error?: string;
  }> {
    const result = await this.deleteAgent(agentId, orgId);
    if (!result.success) {
      // If the row is already gone, treat as success. This covers the retry
      // case where a prior attempt deleted the row but failed before updating
      // the job status to "completed", causing the runner to retry.
      if (result.error === "Agent not found") {
        return { success: true, containerStopped: true };
      }
      return {
        success: false,
        containerStopped: false,
        error: result.error,
      };
    }

    // Character deletion used to live in the HTTP DELETE handler. Now that
    // delete is async via the queue, the daemon owns this step so orphan
    // characters do not pile up when the deletion completes outside of an
    // HTTP request context. Best-effort: a failure here leaves an orphan
    // row but does not un-delete the (already gone) sandbox.
    const characterId = result.deletedSandbox.character_id;
    if (characterId && !reusesExistingElizaCharacter(result.deletedSandbox.agent_config)) {
      try {
        await userCharactersRepository.delete(characterId);
        logger.info("[agent-sandbox] Cleaned up linked character after delete", {
          agentId,
          characterId,
        });
      } catch (charErr) {
        logger.warn("[agent-sandbox] Linked character cleanup failed after delete", {
          agentId,
          characterId,
          error: charErr instanceof Error ? charErr.message : String(charErr),
        });
      }
    }

    return {
      success: true,
      // If we got past the stop step at all, by the time we returned success
      // the container was either stopped or was never there. Either way it
      // is no longer running, which is what the daemon needs to know to
      // mark the job complete.
      containerStopped: true,
    };
  }

  // Provision

  async provision(agentId: string, orgId: string): Promise<ProvisionResult> {
    let rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" } as ProvisionResult;

    const previousStatus = rec.status;
    const lock = await agentSandboxesRepository.trySetProvisioning(rec.id);
    if (!lock) {
      if (rec.status === "running" && rec.bridge_url && rec.health_url)
        return {
          success: true,
          sandboxRecord: rec,
          bridgeUrl: rec.bridge_url,
          healthUrl: rec.health_url,
        };
      return {
        success: false,
        sandboxRecord: rec,
        error: "Agent is already being provisioned",
      };
    }
    rec = lock;

    // 1. Database
    let dbUri = rec.database_uri;
    if (rec.database_status !== "ready" || !dbUri) {
      const db = await this.provisionAgentDatabase(rec);
      if (!db.success) {
        await this.markError(rec, `Database provisioning failed: ${db.error}`);
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: db.error ?? "Unknown database error",
        };
      }
      dbUri = db.connectionUri!;
      // DB assignment updates the row but doesn't return the full record; re-fetch to avoid stale data
      const refreshed = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
      if (refreshed) {
        rec = refreshed;
      }
    }

    const managedEnvironment = await prepareManagedElizaEnvironment({
      existingEnv: (rec.environment_vars as Record<string, string>) ?? {},
      organizationId: rec.organization_id,
      userId: rec.user_id,
      sandboxId: agentId,
    });
    const containerLaunch = resolveSandboxContainerLaunchConfig(rec.agent_config);

    if (managedEnvironment.changed) {
      const updatedEnvRecord = await agentSandboxesRepository.update(rec.id, {
        environment_vars: managedEnvironment.environmentVars,
      });
      if (updatedEnvRecord) {
        rec = updatedEnvRecord;
      } else {
        rec = {
          ...rec,
          environment_vars: managedEnvironment.environmentVars,
        };
      }
    }

    // 2-5. Sandbox creation + DB persistence with retry for port collision
    // TOCTOU race: Port allocation happens in-memory (provider allocates next available port),
    // but persistence to DB (unique constraint on node_id + bridge_port) happens later.
    // If two concurrent provisions pick the same port, one will fail with PG 23505.
    // Solution: Retry loop catches unique constraint errors, cleans up ghost container, and retries.
    const MAX_PROVISION_ATTEMPTS = 3;
    let lastError: string = "Unknown error";
    const provisionDockerImage = resolveManagedProvisionDockerImage(rec.docker_image);

    // Materialize the stored env for the container: BYO secrets are encrypted
    // at rest (#11332); compatibility plaintext values pass through unchanged. A
    // decrypt failure fails the provision (never boot a container with
    // ciphertext standing in for a secret) and is surfaced like any other
    // pre-provision failure.
    let materializedEnv: Record<string, string>;
    try {
      materializedEnv = await decryptAgentEnvVars(
        (rec.environment_vars as Record<string, string>) ?? {},
      );
    } catch (envError) {
      const message = envError instanceof Error ? envError.message : String(envError);
      await this.markError(rec, `Environment decryption failed: ${message}`);
      return {
        success: false,
        sandboxRecord: await agentSandboxesRepository.findById(rec.id),
        error: message,
      };
    }

    for (let attempt = 1; attempt <= MAX_PROVISION_ATTEMPTS; attempt++) {
      let handle;

      try {
        const retryHandle =
          attempt === 1 && previousStatus === "provisioning"
            ? this.buildProvisioningRetryHandle(rec)
            : null;
        if (retryHandle) {
          handle = retryHandle;
          logger.info("[agent-sandbox] Re-probing persisted provisioning container before create", {
            agentId: rec.id,
            sandboxId: handle.sandboxId,
          });
        } else {
          // 2. Sandbox (via provider)
          const callerEnv = materializedEnv;
          // DATABASE_URL precedence: a self-contained image (e.g. a coding
          // container running its own bot) can ship its OWN database. Do not
          // silently clobber it with the managed shared DB URL — that would force the
          // image onto a DB it never asked for. If the caller already set
          // DATABASE_URL, keep it and expose the managed URL under a distinct
          // name (ELIZA_MANAGED_DATABASE_URL) so the image can opt in. Only when
          // the caller did NOT supply one do we inject the managed URL as
          // DATABASE_URL — the normal managed-agent path, byte-identical to before.
          const dbEnv = computeManagedAgentDbEnv(callerEnv, dbUri);
          handle = await (await this.getProvider()).create({
            agentId: rec.id,
            agentName: rec.agent_name ?? "CloudAgent",
            organizationId: rec.organization_id,
            environmentVars: {
              ...callerEnv,
              ...dbEnv,
            },
            // Path A: pass the persisted character so the container boots AS
            // this agent (see docker-sandbox-provider ELIZA_AGENT_CHARACTER_JSON
            // injection + packages/agent/src/runtime/sandbox-character.ts).
            agentConfig:
              rec.agent_config &&
              typeof rec.agent_config === "object" &&
              !Array.isArray(rec.agent_config)
                ? (rec.agent_config as Record<string, unknown>)
                : undefined,
            // Path A: the gateways route by character_id, so the container must
            // register under, and answer as, that id (see
            // SANDBOX_ROUTE_AGENT_ID injection).
            routeAgentId: rec.character_id ?? undefined,
            snapshotId: rec.snapshot_id ?? undefined,
            dockerImage: provisionDockerImage,
            container: containerLaunch,
          });
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await this.markError(rec, `Sandbox creation failed: ${msg}`);
        return {
          success: false,
          sandboxRecord: await agentSandboxesRepository.findById(rec.id),
          error: msg,
        };
      }

      try {
        // 3. Health check (via provider). Use the detailed probe so a
        // TRANSPORT-unresolved outcome (the probe never actually reached the
        // container — SSH flapping / node briefly unreachable) is treated as a
        // RETRYABLE condition instead of tearing down a likely-healthy
        // container and marking the row failed (the readiness-probe
        // false-negative split-brain, #15310 failure mode #6). A genuine
        // not-ready still fails the provision and self-heals via the normal
        // timeout path.
        const provider = await this.getProvider();
        const health = provider.checkHealthDetailed
          ? await provider.checkHealthDetailed(handle)
          : {
              ready: await provider.checkHealth(handle),
              verdict: "not_ready" as const,
            };

        const dockerMeta = isDockerSandboxMetadata(handle.metadata) ? handle.metadata : undefined;

        if (!health.ready) {
          if (health.verdict === "transport_unresolved") {
            // Do NOT tear the container down: the probe never reached it, so it
            // is probably up and serving. PERSIST the container handle onto the
            // row (status stays `provisioning`) BEFORE throwing so that:
            //   (1) the daemon-side stuck-provisioning reconciler can FIND the
            //       row — it requires `sandbox_id IS NOT NULL` — and re-probe /
            //       flip it to `running` once transport recovers, and
            //   (2) a provision-job retry ADOPTS the same container (name +
            //       ports already on the row) instead of re-creating the
            //       deterministic container name, hitting an "already in use"
            //       collision, and tearing down the very container we preserved.
            // Without this write the leave-and-reconcile path is defeated for
            // exactly the SSH-transport-blip case it exists for.
            await this.persistContainerHandleForRetry(rec.id, handle, dockerMeta);
            throw new SandboxTransportUnresolvedError(
              "Sandbox readiness probe could not reach the container (SSH transport unresolved); " +
                "leaving the container in place for retry/reconciliation",
            );
          }
          throw new Error("Sandbox health check timed out");
        }

        // C1b attribution guard (audit §C1b/§C5): a docker-fleet container MUST
        // carry a durable node_id before we flip the row to `running`. dockerMeta
        // is undefined whenever the strict type guard fails (metadata shape
        // drift: a missing field, or the empty-string nodeId that a partial
        // provider handle can produce). In that case the row would be flipped to
        // running + bridge_url set with node_id NULL — an unattributable orphan
        // that (a) undercounts the node recount (over-scheduling, autoscaler
        // spawns billable nodes — #15378), and (b) the orphan reconciler PROVABLY
        // cannot reap (allHaveNodeAndStamp skips live null-node rows — §C5). So
        // when the handle self-identifies as docker-backed but we have no usable
        // nodeId, fail LOUD and NON-retryable instead of minting the orphan. The
        // container already exists; the catch below stops it per the standard
        // post-create-failure convention and this message (distinct from the
        // unique/duplicate/23505 retry patterns) breaks straight to markError.
        //
        // Non-docker providers (local-docker, memory) have no node concept and
        // are unaffected. This does NOT touch the shared-tier insert path
        // (buildAgentInsertData), which is running-with-null-node BY DESIGN.
        if (isDockerBackedMetadata(handle.metadata) && !dockerMeta?.nodeId) {
          logger.warn(
            "[agent-sandbox] Refusing to flip running: docker-backed handle has no durable node_id",
            {
              agentId: rec.id,
              sandboxId: handle.sandboxId,
              executionTier: rec.execution_tier,
              hasDockerMeta: Boolean(dockerMeta),
              metadataProvider:
                typeof handle.metadata === "object" && handle.metadata !== null
                  ? (handle.metadata as { provider?: unknown }).provider
                  : undefined,
            },
          );
          throw new Error(
            `${PROVISION_ATTRIBUTION_GUARD_PREFIX} docker-backed sandbox ${handle.sandboxId} produced no durable node_id (metadata shape drift or empty nodeId); refusing to mark running with node_id NULL`,
          );
        }

        const runtimeRec = {
          ...rec,
          sandbox_id: handle.sandboxId,
          bridge_url: handle.bridgeUrl,
          health_url: handle.healthUrl,
          node_id: dockerMeta?.nodeId ?? rec.node_id,
          container_name: dockerMeta?.containerName ?? rec.container_name,
          bridge_port: dockerMeta?.bridgePort ?? rec.bridge_port,
          web_ui_port: dockerMeta?.webUiPort ?? rec.web_ui_port,
          headscale_ip: dockerMeta?.headscaleIp ?? rec.headscale_ip,
        };

        await this.ensureRuntimeAgentStarted(runtimeRec);

        // 4. Mark running + persist provider-specific metadata.
        //
        // This write happens BEFORE the backup restore on purpose: the status
        // column is the reachability gate — the dedicated-agent proxy
        // synthesizes a 202 "starting" for EVERY request (including the
        // launcher's /api/status poll) until status='running'. The container is
        // serving from this moment (health checked, runtime agent started), so
        // gating the flip on the restore tail made a responsive agent read as
        // "waking" for the whole restore — the launcher escalated to "taking
        // longer than usual" while chat already answered (#14038). A restore
        // failure still flips the row out of 'running' via the catch below
        // (ghost cleanup → retry or markError), so 'running' never sticks on a
        // failed provision.
        const updateData: Parameters<typeof agentSandboxesRepository.update>[1] = {
          status: "running",
          sandbox_id: handle.sandboxId,
          bridge_url: handle.bridgeUrl,
          health_url: handle.healthUrl,
          last_heartbeat_at: new Date(),
          error_message: null,
        };

        if (dockerMeta) {
          if (dockerMeta.nodeId) updateData.node_id = dockerMeta.nodeId;
          if (dockerMeta.containerName) updateData.container_name = dockerMeta.containerName;
          if (dockerMeta.bridgePort) updateData.bridge_port = dockerMeta.bridgePort;
          if (dockerMeta.webUiPort) updateData.web_ui_port = dockerMeta.webUiPort;
          if (dockerMeta.headscaleIp) updateData.headscale_ip = dockerMeta.headscaleIp;
          if (dockerMeta.dockerImage) updateData.docker_image = dockerMeta.dockerImage;
          // Always overwrite the digest (including null) so a re-provision
          // onto a different image clears any stale value. The reconciler
          // treats null as "unknown, wait until probe succeeds before
          // deciding", which is what we want during registry outages.
          updateData.image_digest = dockerMeta.imageDigest;
        }

        const updated = await agentSandboxesRepository.update(rec.id, updateData);

        // Re-enter the billable set on every successful provision. A
        // credit-suspended agent (billing_status='suspended') that a user tops
        // up and resumes/wakes via the user-facing routes would otherwise run
        // (status='running') permanently EXCLUDED from listBillableSandboxes =
        // free dedicated compute forever. The service-key resume/restart routes
        // already reactivate; do it here so ALL provision paths re-enter billing.
        // Idempotent + exempt-guarded (ne billing_status 'exempt').
        await agentBillingRepository.reactivateSandboxBillingAfterFunding(rec.id, new Date());

        // 5. Restore from backup (reconstructs incrementals back to a full).
        //
        // The snapshot holds only volatile in-memory session state — the agent's
        // identity, config, and durable data live in the DB record — so an
        // UNRECOVERABLE snapshot degrades to a FRESH boot instead of failing the
        // whole provision closed (error-policy:J4 designed degrade — the state is
        // unrestorable regardless of retries, so booting without prior in-memory
        // state is correct, not a fabricated success). Two unrecoverable shapes,
        // classified by `isUnrecoverableSnapshotError`: UNDECRYPTABLE (the org
        // DEK that encrypted it is gone — the ephemeral `memory` KMS backend
        // rotates its key on every restart — or the bytes are corrupt) and
        // UNRESTORABLE (the restore push is rejected with a permanent HTTP
        // status; HQ 14308 bricked an agent on a deterministic 401). Degrading on
        // FIRST detection matters: these failures re-fail identically on every
        // attempt, so retrying only burns the provision attempts and lands in
        // markError. A transient DB/IO/network/5xx error is rethrown so the
        // provision fails and the resume job retries rather than silently
        // discarding recoverable state.
        let backup: Awaited<ReturnType<typeof agentSandboxesRepository.getLatestBackup>>;
        let restoreState: Awaited<
          ReturnType<typeof agentSandboxesRepository.getReconstructedBackupState>
        >;
        try {
          backup = await agentSandboxesRepository.getLatestBackup(rec.id);
          restoreState = backup
            ? await agentSandboxesRepository.getReconstructedBackupState(backup.id)
            : undefined;
        } catch (error) {
          if (!isUnrecoverableSnapshotError(error)) throw error;
          await this.degradeUnrecoverableSnapshot(rec.id, backup?.id, error);
          backup = undefined;
          restoreState = undefined;
        }
        if (restoreState) {
          try {
            await this.pushState(handle.bridgeUrl, restoreState, {
              trusted: true,
              authRec: rec,
            });
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (
              rec.execution_tier === "custom" &&
              message.startsWith("State restore failed: HTTP 404")
            ) {
              // Designed benign skip, checked BEFORE the unrecoverable degrade:
              // a custom image simply lacks the restore endpoint, so the
              // snapshot stays intact for a future image that has one.
              logger.info(
                "[agent-sandbox] Backup restore skipped: custom image has no restore endpoint",
                {
                  agentId: rec.id,
                  backupId: backup?.id,
                },
              );
            } else if (isUnrecoverableSnapshotError(error)) {
              await this.degradeUnrecoverableSnapshot(rec.id, backup?.id, error);
            } else {
              throw error;
            }
          }
        } else if (backup) {
          logger.warn("[agent-sandbox] Backup restore skipped: reconstructed state was null", {
            agentId: rec.id,
            backupId: backup.id,
          });
        }

        logger.info("[agent-sandbox] Provisioned", {
          agentId: rec.id,
          sandboxId: handle.sandboxId,
          attempt,
        });
        return {
          success: true,
          sandboxRecord: updated!,
          bridgeUrl: handle.bridgeUrl,
          healthUrl: handle.healthUrl,
        };
      } catch (err) {
        // Ghost container deletion: provider.create() succeeded but DB update or health check failed
        const msg = err instanceof Error ? err.message : String(err);
        lastError = msg;

        // Transport-unresolved readiness probe: the probe never reached the
        // container, so it is likely healthy. DO NOT tear it down and DO NOT
        // markError — that is exactly the false-negative that wedges a healthy
        // row (#15310 #6). Leave the container running and return a RETRYABLE
        // failure: the provision job retries, and the daemon stuck-provisioning
        // reconciler re-probes and flips the row to `running` once transport
        // recovers. Preserve the (pending/provisioning) row so the reconciler
        // and job retry both have something to act on.
        if (err instanceof SandboxTransportUnresolvedError) {
          logger.warn(
            "[agent-sandbox] Readiness probe transport-unresolved; leaving container in place for retry/reconciliation",
            { agentId: rec.id, sandboxId: handle.sandboxId, attempt },
          );
          return {
            success: false,
            retryable: true,
            sandboxRecord: await agentSandboxesRepository.findById(rec.id),
            error: msg,
          };
        }

        logger.warn("[agent-sandbox] Post-create failure, cleaning up container", {
          agentId: rec.id,
          sandboxId: handle.sandboxId,
          attempt,
          error: msg,
        });

        await (await this.getProvider()).stop(handle.sandboxId).catch((stopErr) => {
          logger.error("[agent-sandbox] Ghost container cleanup failed", {
            sandboxId: handle.sandboxId,
            error: stopErr instanceof Error ? stopErr.message : String(stopErr),
          });
        });

        // Check if it's a unique constraint error (port collision) -> retry
        const isUniqueConstraintError =
          msg.includes("23505") ||
          msg.toLowerCase().includes("unique") ||
          msg.toLowerCase().includes("duplicate");

        if (isUniqueConstraintError && attempt < MAX_PROVISION_ATTEMPTS) {
          logger.info("[agent-sandbox] Port collision detected, retrying", {
            attempt,
            nextAttempt: attempt + 1,
          });
          continue; // Retry
        }

        // Non-retryable error or max attempts reached -> fail
        break;
      }
    }

    // All attempts exhausted
    await this.markError(
      rec,
      `Provisioning failed after ${MAX_PROVISION_ATTEMPTS} attempts: ${lastError}`,
    );
    return {
      success: false,
      sandboxRecord: await agentSandboxesRepository.findById(rec.id),
      error: lastError,
    };
  }

  private async getSafeBridgeEndpoint(
    sandboxOrBridgeUrl:
      | Pick<AgentSandbox, "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id">
      | string,
    path: string,
    options?: { trusted?: boolean },
  ): Promise<string> {
    if (typeof sandboxOrBridgeUrl === "string") {
      if (options?.trusted) {
        return new URL(path, sandboxOrBridgeUrl).toString();
      }

      return (await assertSafeOutboundUrl(new URL(path, sandboxOrBridgeUrl).toString())).toString();
    }

    const dockerBridgeBaseUrl = await this.getTrustedDockerBridgeBaseUrl(sandboxOrBridgeUrl);
    if (
      dockerBridgeBaseUrl &&
      sandboxOrBridgeUrl.bridge_url &&
      this.matchesTrustedDockerBridge(sandboxOrBridgeUrl.bridge_url, dockerBridgeBaseUrl)
    ) {
      return new URL(path, dockerBridgeBaseUrl).toString();
    }

    if (!sandboxOrBridgeUrl.bridge_url) {
      throw new Error("Sandbox bridge is missing");
    }

    if (this.isTrustedLegacyPrivateBridgeUrl(sandboxOrBridgeUrl)) {
      return new URL(path, sandboxOrBridgeUrl.bridge_url).toString();
    }

    return (
      await assertSafeOutboundUrl(new URL(path, sandboxOrBridgeUrl.bridge_url).toString())
    ).toString();
  }

  private getConfiguredAgentBaseDomain(): string | null {
    const configured = getCloudAwareEnv().ELIZA_CLOUD_AGENT_BASE_DOMAIN?.trim();
    if (!configured) return null;
    return this.normalizeConfiguredHostname(configured);
  }

  private getConfiguredAgentRouterOriginHost(): string | null {
    const configured = getCloudAwareEnv().AGENT_ROUTER_ORIGIN_HOST?.trim();
    if (!configured) return null;
    return this.normalizeConfiguredHostname(configured);
  }

  private normalizeConfiguredHostname(hostname: string): string | null {
    const normalized = hostname
      .replace(/^https?:\/\//, "")
      .replace(/\/.*$/, "")
      .toLowerCase()
      .replace(/\.+$/, "");
    return normalized || null;
  }

  private async getAgentApiEndpoint(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    path: string,
  ): Promise<string> {
    const isWorkerRuntime = this.isCloudflareWorkerRuntime();
    const baseDomain = this.getConfiguredAgentBaseDomain();
    if (isWorkerRuntime && baseDomain) {
      const publicEndpoint = getElizaAgentPublicWebUiUrl(rec, { baseDomain, path });
      if (publicEndpoint) return publicEndpoint;
    }

    const trustedWebBaseUrl = await this.getTrustedDockerWebBaseUrl(rec);
    if (trustedWebBaseUrl) {
      return new URL(path, trustedWebBaseUrl).toString();
    }

    if (baseDomain) {
      const publicEndpoint = getElizaAgentPublicWebUiUrl(rec, {
        baseDomain,
        path,
      });
      if (publicEndpoint) return publicEndpoint;
    }

    return this.getSafeBridgeEndpoint(rec, path);
  }

  private async getAgentWebFetchTarget(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    path: string,
  ): Promise<{ url: string; forwardedHost?: string }> {
    const originHost = this.isCloudflareWorkerRuntime()
      ? this.getConfiguredAgentRouterOriginHost()
      : null;
    if (originHost) {
      const baseDomain = this.getConfiguredAgentBaseDomain();
      const publicEndpoint = getElizaAgentPublicWebUiUrl(
        rec,
        baseDomain ? { baseDomain, path } : { path },
      );
      if (publicEndpoint) {
        const agentHost = new URL(publicEndpoint).host;
        const url = new URL(path, `https://${originHost}`).toString();
        return { url, forwardedHost: agentHost };
      }
    }

    return { url: await this.getAgentWebEndpoint(rec, path) };
  }

  private async getAgentWebEndpoint(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
    >,
    path: string,
  ): Promise<string> {
    const baseDomain = this.getConfiguredAgentBaseDomain();
    const publicEndpoint = getElizaAgentPublicWebUiUrl(
      rec,
      baseDomain ? { baseDomain, path } : { path },
    );
    if (publicEndpoint) return publicEndpoint;

    const trustedWebBaseUrl = await this.getTrustedDockerWebBaseUrl(rec);
    if (trustedWebBaseUrl) {
      return new URL(path, trustedWebBaseUrl).toString();
    }

    return this.getSafeBridgeEndpoint(rec, path);
  }

  private async getTrustedDockerWebBaseUrl(
    sandbox: Pick<
      AgentSandbox,
      "node_id" | "web_ui_port" | "headscale_ip" | "health_url" | "bridge_url"
    >,
  ): Promise<string | null> {
    if (sandbox.health_url) {
      try {
        return new URL(sandbox.health_url).origin;
      } catch {
        // Fall through to metadata-based resolution.
      }
    }

    if (!sandbox.node_id || !sandbox.web_ui_port) {
      return null;
    }

    const host =
      sandbox.headscale_ip || (await dockerNodesRepository.findByNodeId(sandbox.node_id))?.hostname;
    if (!host) {
      return null;
    }

    return `http://${host}:${sandbox.web_ui_port}`;
  }

  private async getTrustedDockerBridgeBaseUrl(
    sandbox: Pick<AgentSandbox, "node_id" | "bridge_port" | "headscale_ip">,
  ): Promise<string | null> {
    if (!sandbox.node_id || !sandbox.bridge_port) {
      return null;
    }

    const host =
      sandbox.headscale_ip || (await dockerNodesRepository.findByNodeId(sandbox.node_id))?.hostname;
    if (!host) {
      return null;
    }

    return `http://${host}:${sandbox.bridge_port}`;
  }

  private isTrustedLegacyPrivateBridgeUrl(
    sandbox: Pick<
      AgentSandbox,
      "bridge_url" | "node_id" | "bridge_port" | "headscale_ip" | "sandbox_id"
    >,
  ): boolean {
    if (!sandbox.bridge_url) {
      return false;
    }

    let candidate: URL;
    try {
      candidate = new URL(sandbox.bridge_url);
    } catch {
      return false;
    }

    if (candidate.protocol !== "http:" || !this.isAgentPrivateBridgeHost(candidate.hostname)) {
      return false;
    }

    const candidatePort = Number.parseInt(candidate.port, 10);
    const hasMatchingBridgePort =
      sandbox.bridge_port != null &&
      Number.isInteger(candidatePort) &&
      candidatePort === sandbox.bridge_port;
    const hasMatchingHeadscaleIp =
      !!sandbox.headscale_ip && candidate.hostname === sandbox.headscale_ip;
    const hasDockerNodeSignal = !!sandbox.node_id;
    // Older Docker-backed records may predate the node/headscale backfill but
    // still carry the provider-generated `sandbox_id`/container name.

    return (
      hasMatchingHeadscaleIp ||
      (hasDockerNodeSignal && hasMatchingBridgePort) ||
      (hasDockerNodeSignal && hasMatchingHeadscaleIp)
    );
  }

  private isLegacyDockerSandboxId(sandboxId: string | null | undefined): boolean {
    return typeof sandboxId === "string" && /^agent-[0-9a-f-]{36}$/i.test(sandboxId);
  }

  private isAgentPrivateBridgeHost(hostname: string): boolean {
    if (isIP(hostname) !== 4) {
      return false;
    }

    const [first, second] = hostname.split(".").map((part) => Number.parseInt(part, 10));
    // CGNAT (100.64.0.0/10)
    if (first === 100 && second >= 64 && second <= 127) return true;
    // RFC1918: 10.0.0.0/8
    if (first === 10) return true;
    // RFC1918: 172.16.0.0/12
    if (first === 172 && second >= 16 && second <= 31) return true;
    // RFC1918: 192.168.0.0/16
    if (first === 192 && second === 168) return true;
    return false;
  }

  private matchesTrustedDockerBridge(
    bridgeUrl: string,
    trustedDockerBridgeBaseUrl: string,
  ): boolean {
    try {
      const candidate = new URL(bridgeUrl);
      const trusted = new URL(trustedDockerBridgeBaseUrl);
      return candidate.host === trusted.host;
    } catch {
      return false;
    }
  }

  private isCloudflareWorkerRuntime(): boolean {
    return typeof globalThis !== "undefined" && "WebSocketPair" in globalThis;
  }

  private sharedRuntimeStringValue(value: unknown): string | undefined {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  }

  private sharedRuntimeStringList(value: unknown): string[] {
    if (typeof value === "string" && value.trim()) return [value.trim()];
    if (!Array.isArray(value)) return [];
    return value.filter(
      (item): item is string => typeof item === "string" && item.trim().length > 0,
    );
  }

  private isSharedTurnMessage(value: unknown): value is SharedTurnMessage {
    const message = this.nestedBridgeRecord(value);
    return (
      (message?.role === "user" || message?.role === "assistant") &&
      typeof message.content === "string" &&
      message.content.trim().length > 0
    );
  }

  private async loadSharedRuntimeHistory(
    agentId: string,
    channelId: string,
  ): Promise<SharedTurnMessage[]> {
    // Durable source of truth is Postgres (the cache is disabled on the prod
    // Worker, CACHE_ENABLED=false, so it never persisted). See
    // db/schemas/shared-runtime-history.ts.
    const stored = await sharedRuntimeHistoryRepository.get(agentId, channelId);
    return stored.filter((message): message is SharedTurnMessage =>
      this.isSharedTurnMessage(message),
    );
  }

  private async saveSharedRuntimeHistory(
    agentId: string,
    channelId: string,
    history: SharedTurnMessage[],
  ): Promise<void> {
    const capped =
      history.length > SHARED_RUNTIME_HISTORY_MAX_MESSAGES
        ? history.slice(history.length - SHARED_RUNTIME_HISTORY_MAX_MESSAGES)
        : history;
    await sharedRuntimeHistoryRepository.upsert(agentId, channelId, capped);
  }

  private sharedRuntimeBillingPrompt(
    character: SharedAgentCharacter,
    history: SharedTurnMessage[],
    message: string,
  ): Array<{ content: string }> {
    return [
      { content: character.system },
      ...(character.bio ?? []).map((content) => ({ content })),
      ...history.map((turn) => ({ content: turn.content })),
      { content: message },
    ].filter((entry) => entry.content.trim().length > 0);
  }

  private sharedRuntimeBillingUsage(
    turn: RunSharedAgentTurnResult,
    estimatedInputTokens: number,
  ): AIUsage {
    const inputTokens = turn.usage?.inputTokens ?? turn.usage?.promptTokens ?? 0;
    const outputTokens = turn.usage?.outputTokens ?? turn.usage?.completionTokens ?? 0;
    const totalTokens = turn.usage?.totalTokens ?? inputTokens + outputTokens;
    if (inputTokens > 0 || outputTokens > 0 || totalTokens > 0) {
      return turn.usage ?? {};
    }
    return {
      inputTokens: estimatedInputTokens,
      outputTokens: estimateInputTokens([{ content: turn.reply }]),
    };
  }

  private async buildSharedRuntimeCharacter(rec: AgentSandbox): Promise<SharedAgentCharacter> {
    const config = this.nestedBridgeRecord(rec.agent_config) ?? {};
    const configCharacter = this.nestedBridgeRecord(config.character) ?? config;
    const linkedCharacter = rec.character_id
      ? await userCharactersRepository.findByIdInOrganization(rec.character_id, rec.organization_id)
      : undefined;
    const linkedSettings = this.nestedBridgeRecord(linkedCharacter?.settings);

    const name =
      this.sharedRuntimeStringValue(linkedCharacter?.name) ??
      this.sharedRuntimeStringValue(configCharacter.name) ??
      this.sharedRuntimeStringValue(config.name) ??
      rec.agent_name ??
      "Eliza agent";
    const system =
      this.sharedRuntimeStringValue(linkedCharacter?.system) ??
      this.sharedRuntimeStringValue(configCharacter.system) ??
      this.sharedRuntimeStringValue(config.system) ??
      this.sharedRuntimeStringValue(configCharacter.prompt) ??
      this.sharedRuntimeStringValue(config.prompt) ??
      `You are ${name}, a helpful assistant.`;
    const bio = [
      ...this.sharedRuntimeStringList(linkedCharacter?.bio),
      ...this.sharedRuntimeStringList(configCharacter.bio),
      ...this.sharedRuntimeStringList(config.bio),
    ];
    const model =
      this.sharedRuntimeStringValue(linkedSettings?.model) ??
      this.sharedRuntimeStringValue(configCharacter.model) ??
      this.sharedRuntimeStringValue(config.model);

    return {
      name,
      system,
      ...(bio.length > 0 ? { bio } : {}),
      ...(model ? { model } : {}),
    };
  }

  private async bridgeSharedStatus(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        status: "running",
        ready: true,
        agentId: rec.id,
        agentName: rec.agent_name ?? undefined,
        runtime: "shared",
      },
    };
  }

  private async bridgeSharedMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
  ): Promise<BridgeResponse> {
    const params = rpc.params && typeof rpc.params === "object" ? rpc.params : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "message.send requires params.text" },
      };
    }

    const channelId = this.stableBridgeChannelId(rec.id, params);
    const [character, history] = await Promise.all([
      this.buildSharedRuntimeCharacter(rec),
      this.loadSharedRuntimeHistory(rec.id, channelId),
    ]);
    const billingModel = resolveSharedAgentTurnModel(character.model);
    const estimatedInputTokens = billingModel
      ? estimateInputTokens(this.sharedRuntimeBillingPrompt(character, history, text))
      : 0;
    const idempotencyKey = `shared-runtime:${rec.id}:${channelId}:${crypto.randomUUID()}`;
    const requestId = `shared-runtime-${crypto.randomUUID()}`;
    const billingContext: BillingContext | null = billingModel
      ? {
          organizationId: rec.organization_id,
          userId: rec.user_id,
          model: billingModel,
          requestId,
          description: `Shared runtime turn: ${character.name}`,
          metadata: {
            agentId: rec.id,
            channelId,
            executionTier: rec.execution_tier,
            idempotencyKey,
            prompt: text,
            runtime: "shared",
          },
        }
      : null;
    let reservation: CreditReservation | null = null;
    let reservationSettled = false;
    const settleReservation = async (
      actualCost: number,
    ): Promise<CreditReconciliationResult | null> => {
      if (!reservation || reservationSettled) return null;
      reservationSettled = true;
      return (await reservation.reconcile(actualCost)) ?? null;
    };
    if (billingContext) {
      try {
        reservation = await reserveCredits(billingContext, estimatedInputTokens, 500);
      } catch (error) {
        if (error instanceof InsufficientCreditsError) {
          return {
            jsonrpc: "2.0",
            id: rpc.id,
            error: {
              code: BRIDGE_INSUFFICIENT_CREDITS_CODE,
              message: `Insufficient credits. Required: $${error.required.toFixed(4)}, Available: $${error.available.toFixed(4)}`,
            },
          };
        }
        throw error;
      }
    }
    // #11169-class refund guard: the reserve above is settled on the degraded
    // and billing-failure paths below, but a THROW between here and the settle —
    // runSharedAgentTurn raising, or saveSharedRuntimeHistory hitting a DB blip
    // (it runs OUTSIDE the inner billing try/catch) — would otherwise propagate
    // without ever refunding, stranding the hold and over-charging the org.
    // settleReservation is idempotent (reservationSettled), so refunding here
    // never double-refunds a turn that already settled on a normal path.
    try {
      const turn = await runSharedAgentTurn({
        character,
        history,
        message: text,
      });
      if (turn.degraded) {
        // A failed/degraded turn isn't persisted or billed — just refund the hold.
        await settleReservation(0);
      } else {
        await this.saveSharedRuntimeHistory(rec.id, channelId, turn.history);
        if (billingContext) {
          try {
            const billing = await billUsage(
              billingContext,
              this.sharedRuntimeBillingUsage(turn, estimatedInputTokens),
            );
            const settlement = await settleReservation(billing.totalCost);
            const usageRecord = await recordUsageAnalytics(billingContext, billing, {
              type: "chat",
              content: turn.reply,
              prompt: text,
            });
            if (usageRecord) {
              await aiBillingRecordsService
                .record({
                  context: billingContext,
                  billing,
                  usageRecord,
                  idempotencyKey,
                  reconciliation: settlement,
                })
                .catch((error) => {
                  logger.error("[shared-runtime] AI billing audit record failed", {
                    error: error instanceof Error ? error.message : String(error),
                    agentId: rec.id,
                  });
                });
            }
          } catch (error) {
            await settleReservation(0);
            logger.error("[shared-runtime] billing failed", {
              error: error instanceof Error ? error.message : String(error),
              agentId: rec.id,
            });
          }
        }
      }

      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          text: turn.reply,
          agentName: character.name,
          channelId,
          model: turn.model,
          degraded: turn.degraded,
          runtime: "shared",
          transport: "shared-runtime",
        },
      };
    } catch (settleError) {
      // Refund the upfront hold on any post-reserve failure, then rethrow.
      await settleReservation(0);
      throw settleError;
    }
  }

  /**
   * Read the persisted turn history for a shared-runtime agent's room, keyed by
   * the SAME stable channel id the bridge `message.send` path writes under — so
   * the REST conversation adapter (cloud-api `.../agents/:id/api/*`) returns the
   * exact transcript the bridge produced. `roomId` defaults to the agent id (the
   * canonical single-conversation channel the adapter uses).
   */
  async getSharedConversationHistory(
    agentId: string,
    roomId?: string,
  ): Promise<SharedTurnMessage[]> {
    const channelId = this.stableBridgeChannelId(agentId, {
      roomId: roomId ?? agentId,
    });
    return this.loadSharedRuntimeHistory(agentId, channelId);
  }

  /**
   * Resolve the effective character (name/system/bio/model) for a shared-runtime
   * agent — the SAME `SharedAgentCharacter` the bridge `message.send` turn uses,
   * so the REST `GET .../api/character` adapter returns exactly what the agent
   * answers as. Returns `null` when no running shared sandbox matches the org.
   */
  async getSharedRuntimeCharacter(
    agentId: string,
    orgId: string,
  ): Promise<SharedAgentCharacter | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (rec && rec.execution_tier === "shared") {
      return this.buildSharedRuntimeCharacter(rec);
    }
    // Bootstrap window: a freshly-created dedicated agent (not yet "running", so
    // findRunningSandbox misses it) is served by the in-Worker shared runtime
    // until its container boots — return the same character the shared turn uses.
    const bootstrap = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (bootstrap && isDedicatedBootstrapWindow(bootstrap)) {
      return this.buildSharedRuntimeCharacter(bootstrap);
    }
    return null;
  }

  // Bridge

  async bridge(agentId: string, orgId: string, rpc: BridgeRequest): Promise<BridgeResponse> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      // Bootstrap window: a freshly-created dedicated agent whose container is
      // still provisioning is served by the in-Worker shared runtime so the user
      // can chat immediately; the client hands off to the dedicated subdomain
      // once it reports running. (findRunningSandbox misses it since it is not
      // yet "running", so re-resolve by id+org.)
      const bootstrap = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
      if (bootstrap && isDedicatedBootstrapWindow(bootstrap)) {
        return this.bridgeSharedBootstrap(bootstrap, rpc);
      }
      logger.warn("[agent-sandbox] Bridge call to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox is not running" },
      };
    }

    try {
      if (rec.execution_tier === "shared") {
        if (rpc.method === "status.get" || rpc.method === "heartbeat") {
          return await this.bridgeSharedStatus(rec, rpc);
        }
        if (rpc.method === "message.send") {
          return await this.bridgeSharedMessageSend(rec, rpc);
        }
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32601, message: `Method not found: ${rpc.method}` },
        };
      }

      if (!rec.bridge_url) {
        logger.warn("[agent-sandbox] Bridge call to running sandbox without bridge URL", {
          agentId,
          method: rpc.method,
        });
        return {
          jsonrpc: "2.0",
          id: rpc.id,
          error: { code: -32000, message: "Sandbox is not running" },
        };
      }

      if (rpc.method === "status.get" || rpc.method === "heartbeat") {
        return await this.bridgeStatus(rec, rpc);
      }
      if (rpc.method === "message.send") {
        return await this.bridgeMessageSend(rec, rpc);
      }

      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      };
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox bridge is unreachable" },
      };
    }
  }

  /**
   * Bridge dispatch for a DEDICATED agent still in its first-provision bootstrap
   * window (no container yet). Mirrors the shared-tier branch: the in-Worker
   * shared runtime answers status/heartbeat and message.send (billing + KV turn
   * history keyed by the agent id) so the user chats immediately; the client
   * hands off to the dedicated subdomain once the container reports running.
   */
  private async bridgeSharedBootstrap(
    rec: AgentSandbox,
    rpc: BridgeRequest,
  ): Promise<BridgeResponse> {
    try {
      if (rpc.method === "status.get" || rpc.method === "heartbeat") {
        return await this.bridgeSharedStatus(rec, rpc);
      }
      if (rpc.method === "message.send") {
        return await this.bridgeSharedMessageSend(rec, rpc);
      }
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32601, message: `Method not found: ${rpc.method}` },
      };
    } catch (error) {
      logger.warn("[agent-sandbox] Bootstrap bridge request failed", {
        agentId: rec.id,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Sandbox bridge is unreachable" },
      };
    }
  }

  private async bridgeStatus(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    const runtimeAgents = await this.listRuntimeAgents(rec);
    if (runtimeAgents.supported) {
      const agent = this.selectRuntimeAgent(runtimeAgents.agents);
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          status: agent?.status ?? (agent ? "running" : "starting"),
          ready: this.isRuntimeAgentReady(agent),
          agentId: rec.id,
          runtimeAgentId: agent?.id,
          agentName: agent?.name,
        },
      };
    }

    const rootTarget = await this.getAgentWebFetchTarget(rec, "/");
    const headers = this.getAgentJsonHeaders(rec);
    if (rootTarget.forwardedHost) {
      headers["x-forwarded-host"] = rootTarget.forwardedHost;
      headers["x-forwarded-proto"] = "https";
    }
    const rootRes = await fetch(rootTarget.url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(10_000),
    });
    if (!rootRes.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: `Bridge returned HTTP ${rootRes.status}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        status: "running",
        ready: true,
        agentId: rec.id,
        runtime: "web",
        chat: true,
      },
    };
  }

  private async bridgeMessageSend(rec: AgentSandbox, rpc: BridgeRequest): Promise<BridgeResponse> {
    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const text = typeof params.text === "string" ? params.text : "";
    if (!text.trim()) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32602, message: "message.send requires params.text" },
      };
    }

    const attempts = [
      // Try the cloud-agent image's native /bridge JSON-RPC first. This is
      // the canonical surface served by packages/app-core/deploy/cloud-agent-shared.ts.
      // It returns 200 with {result:{text}} on success, 500 with
      // {error:{message}} on runtime failures (e.g. no LLM key). When an
      // image doesn't expose /bridge (public ghcr.io/elizaos/eliza compatibility
      // image) it 404s and we fall through to the REST attempts below.
      () => this.bridgeNativeJsonRpcSend(rec, rpc, params),
      () => this.bridgeConversationMessageSend(rec, rpc, params),
      () => this.bridgeOpenAiChatCompletionSend(rec, rpc, params),
      () => this.bridgeCentralChannelMessageSend(rec, rpc, params),
    ];
    let lastResponse: BridgeResponse | null = null;

    for (const attempt of attempts) {
      try {
        const response = await attempt();
        if (this.bridgeResponseHasText(response)) {
          return response;
        }
        lastResponse = response;
      } catch (error) {
        if (error instanceof BridgeRouteUnavailableError) {
          continue;
        }
        throw error;
      }
    }

    if (lastResponse?.error) {
      return lastResponse;
    }
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);
    if (fallbackText) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          text: fallbackText,
          fallback: true,
          reason: "agent_no_reply",
          transport: "fallback",
        },
      };
    }
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      error: {
        code: -32000,
        message: "Bridge message produced an empty response",
      },
    };
  }

  // Deliberately text-only: a runtime-side canned failure reply (result carries
  // `failureKind`, e.g. "provider issue" / credits-depleted text from
  // packages/agent chat routes) still short-circuits the ladder. Production
  // consumers (agent-gateway connectors, provisioning jobs, the REST adapters)
  // surface that designed failure text to end users; falling through would
  // replace it with the fabricated generic fallback and add up to ~50s of
  // central-channel polling per failed turn. Strict callers (the e2e chat
  // scripts) reject on the propagated `failureKind` instead (#15616).
  private bridgeResponseHasText(response: BridgeResponse): boolean {
    return typeof response.result?.text === "string" && response.result.text.trim().length > 0;
  }

  /**
   * The agent runtime's conversation route answers HTTP 200 with canned text
   * plus a `failureKind` discriminator when the model path is dead (provider
   * issue, rate limit, credit exhaustion, no provider). Surface it so callers
   * can tell a genuine model reply from a canned failure (#15616).
   */
  private extractBridgeFailureKind(body: Record<string, unknown>): string | undefined {
    return typeof body.failureKind === "string" && body.failureKind.trim()
      ? body.failureKind.trim()
      : undefined;
  }

  /**
   * Native JSON-RPC POST to the cloud-agent image's `/bridge` endpoint.
   * Source: packages/app-core/deploy/cloud-agent-shared.ts (the handler this
   * proxies to). Returns the agent's reply unchanged on 200, propagates
   * runtime errors as JSON-RPC error envelopes on 500, throws
   * BridgeRouteUnavailableError on 404 so callers fall through to legacy
   * REST endpoints (the public ghcr.io/elizaos/eliza image doesn't expose
   * /bridge).
   */
  private async bridgeNativeJsonRpcSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    _params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    if (!rec.bridge_url) {
      throw new BridgeRouteUnavailableError("Sandbox has no bridge_url", 0);
    }
    const url = await this.getAgentApiEndpoint(rec, "/bridge");
    const res = await fetch(url, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id ?? null,
        method: "message.send",
        params: rpc.params ?? {},
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError(
        "Cloud-agent /bridge route not present (legacy image?)",
        res.status,
      );
    }
    // Parse envelope; cloud-agent returns valid JSON-RPC on both 200 and 500.
    const body = (await res.json().catch(() => null)) as {
      jsonrpc?: string;
      id?: unknown;
      result?: { text?: string };
      error?: { code?: number; message?: string };
    } | null;
    if (!body || body.jsonrpc !== "2.0") {
      throw new BridgeRouteUnavailableError(
        `Cloud-agent /bridge returned non-JSON-RPC body (status ${res.status})`,
        res.status,
      );
    }
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      ...(body.result
        ? {
            result: {
              ...(body.result as Record<string, unknown>),
              transport: "native-jsonrpc",
            } as BridgeResponse["result"],
          }
        : {}),
      ...(body.error ? { error: body.error as BridgeResponse["error"] } : {}),
    };
  }

  private async bridgeConversationMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const conversationId = await this.createBridgeConversation(rec, params);
    const messageEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/conversations/${encodeURIComponent(conversationId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const failureKind = this.extractBridgeFailureKind(body);
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: this.extractBridgeMessageText(body) ?? "",
        agentName: typeof body.agentName === "string" ? body.agentName : undefined,
        conversationId,
        transport: "conversation-rest",
        ...(failureKind ? { failureKind } : {}),
      },
    };
  }

  private async bridgeMessagingSessionSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const runtimeAgent = (await this.ensureRuntimeAgentStarted(rec)) ?? undefined;
    if (!runtimeAgent?.id) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Runtime agent is not ready" },
      };
    }

    const sessionId = await this.createBridgeMessagingSession(rec, runtimeAgent.id, params);
    const messageEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeSessionMessageBody(params)),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const agentText = await this.waitForBridgeSessionAgentReply(rec, sessionId, runtimeAgent.id);
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: agentText ?? "",
        accepted: true,
        runtimeAgentId: runtimeAgent.id,
        agentName: runtimeAgent.name,
        sessionId,
        messageId: typeof body.id === "string" ? body.id : undefined,
      },
    };
  }

  private async bridgeCentralChannelMessageSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const runtimeAgent = (await this.ensureRuntimeAgentStarted(rec)) ?? undefined;
    if (!runtimeAgent?.id) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: "Runtime agent is not ready" },
      };
    }

    const channelId = this.stableBridgeChannelId(runtimeAgent.id, params);
    const messageEndpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages`,
    );
    const res = await fetch(messageEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeCentralChannelMessageBody(params, runtimeAgent.id)),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError(
        "Central channel messaging API is unavailable",
        res.status,
      );
    }
    if (!res.ok) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: { code: -32000, message: `Bridge returned HTTP ${res.status}` },
      };
    }

    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const data = this.nestedBridgeRecord(body.data) ?? {};
    const agentText = await this.waitForBridgeCentralChannelAgentReply(
      rec,
      channelId,
      runtimeAgent.id,
    );
    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: agentText ?? "",
        accepted: true,
        runtimeAgentId: runtimeAgent.id,
        agentName: runtimeAgent.name,
        channelId,
        transport: "central-channel",
        messageId:
          typeof data.id === "string" ? data.id : typeof body.id === "string" ? body.id : undefined,
      },
    };
  }

  private async bridgeOpenAiChatCompletionSend(
    rec: AgentSandbox,
    rpc: BridgeRequest,
    params: Record<string, unknown>,
  ): Promise<BridgeResponse> {
    const { body, status } = await this.requestBridgeOpenAiChatCompletion(rec, params);
    if (status === 404) {
      throw new BridgeRouteUnavailableError("OpenAI chat compatibility API is unavailable", status);
    }
    if (status < 200 || status >= 300) {
      return {
        jsonrpc: "2.0",
        id: rpc.id,
        error: {
          code: -32000,
          message: this.extractBridgeErrorMessage(body) ?? `Bridge returned HTTP ${status}`,
        },
      };
    }

    return {
      jsonrpc: "2.0",
      id: rpc.id,
      result: {
        text: this.extractOpenAiChatCompletionText(body) ?? "",
        model: typeof body.model === "string" ? body.model : undefined,
        completionId: typeof body.id === "string" ? body.id : undefined,
        transport: "openai-compat",
      },
    };
  }

  private async requestBridgeOpenAiChatCompletion(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const endpoint = await this.getAgentApiEndpoint(rec, "/v1/chat/completions");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify(this.buildBridgeOpenAiChatBody(params)),
      signal: AbortSignal.timeout(120_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, body };
  }

  private buildBridgeOpenAiChatBody(params: Record<string, unknown>): Record<string, unknown> {
    const text = typeof params.text === "string" ? params.text : "";
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId.trim() : "default";
    const userId =
      typeof params.userId === "string" && params.userId.trim()
        ? params.userId.trim()
        : this.stableBridgeUserId(params);
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud";

    return {
      model: "eliza",
      messages: [{ role: "user", content: text }],
      user: roomId,
      metadata: {
        conversation_id: roomId,
        user_id: userId,
        source,
        bridgeRoomId: roomId,
      },
    };
  }

  private buildBridgeNoReplyFallbackText(params: Record<string, unknown>): string | null {
    const text = typeof params.text === "string" ? params.text.trim() : "";
    if (!text) return null;

    const exactWords =
      /\bexact words?\s*:\s*["']?(.+?)["']?\s*$/i.exec(text) ??
      /\breply\s+(?:briefly\s+)?with\s+["']([^"']+)["']/i.exec(text);
    if (exactWords?.[1]?.trim()) {
      return exactWords[1].trim();
    }

    return "Agent runtime is online, but no model response was produced before the cloud bridge timeout.";
  }

  private async createBridgeConversation(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<string> {
    const source =
      typeof params.source === "string" && params.source.trim() ? params.source : "cloud";
    const roomId =
      typeof params.roomId === "string" && params.roomId.trim() ? params.roomId : "default";
    const endpoint = await this.getAgentApiEndpoint(rec, "/api/conversations");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify({
        title: `${source}:${roomId}`.slice(0, 120),
        metadata: { scope: "general" },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      if (res.status === 404) {
        throw new BridgeRouteUnavailableError("Conversation API is unavailable", res.status);
      }
      throw new Error(`Bridge conversation create returned HTTP ${res.status}`);
    }

    const body = (await res.json().catch(() => ({}))) as {
      conversation?: { id?: unknown };
    };
    const conversationId = body.conversation?.id;
    if (typeof conversationId !== "string" || !conversationId.trim()) {
      throw new Error("Bridge conversation create response was missing conversation.id");
    }
    return conversationId;
  }

  private async createBridgeMessagingSession(
    rec: AgentSandbox,
    runtimeAgentId: string,
    params: Record<string, unknown>,
  ): Promise<string> {
    const endpoint = await this.getAgentApiEndpoint(rec, "/api/messaging/sessions");
    const res = await fetch(endpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      body: JSON.stringify({
        agentId: runtimeAgentId,
        userId: this.stableBridgeUserId(params),
        metadata: {
          source:
            typeof params.source === "string" && params.source.trim()
              ? params.source.trim()
              : "cloud",
          roomId: typeof params.roomId === "string" ? params.roomId : undefined,
          sender:
            params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
              ? params.sender
              : undefined,
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status === 404) {
      throw new BridgeRouteUnavailableError("Messaging sessions API is unavailable", res.status);
    }
    if (!res.ok) {
      throw new Error(`Bridge session create returned HTTP ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const sessionId = typeof body.sessionId === "string" ? body.sessionId : undefined;
    if (!sessionId) {
      throw new Error("Bridge session create response was missing sessionId");
    }
    return sessionId;
  }

  private buildBridgeConversationMessageBody(
    params: Record<string, unknown>,
  ): Record<string, unknown> {
    const body: Record<string, unknown> = {
      text: typeof params.text === "string" ? params.text : "",
      source:
        typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud",
      metadata: {
        ...(params.metadata &&
        typeof params.metadata === "object" &&
        !Array.isArray(params.metadata)
          ? (params.metadata as Record<string, unknown>)
          : {}),
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
        bridgeSender:
          params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
            ? params.sender
            : undefined,
      },
    };
    if (params.channelType === "GROUP") {
      body.channelType = "GROUP";
    } else {
      body.channelType = "DM";
    }
    if (params.mode === "power") {
      body.conversationMode = "power";
    } else {
      body.conversationMode = "simple";
    }
    return body;
  }

  private buildBridgeSessionMessageBody(params: Record<string, unknown>): Record<string, unknown> {
    return {
      content: typeof params.text === "string" ? params.text : "",
      attachments: Array.isArray(params.attachments) ? params.attachments : undefined,
      metadata: {
        ...(params.metadata &&
        typeof params.metadata === "object" &&
        !Array.isArray(params.metadata)
          ? (params.metadata as Record<string, unknown>)
          : {}),
        source:
          typeof params.source === "string" && params.source.trim()
            ? params.source.trim()
            : "cloud",
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
      },
    };
  }

  private buildBridgeCentralChannelMessageBody(
    params: Record<string, unknown>,
    runtimeAgentId: string,
  ): Record<string, unknown> {
    const metadata =
      params.metadata && typeof params.metadata === "object" && !Array.isArray(params.metadata)
        ? { ...(params.metadata as Record<string, unknown>) }
        : {};
    const sender =
      params.sender && typeof params.sender === "object" && !Array.isArray(params.sender)
        ? (params.sender as Record<string, unknown>)
        : {};
    const displayName =
      typeof sender.displayName === "string" && sender.displayName.trim()
        ? sender.displayName.trim()
        : typeof sender.name === "string" && sender.name.trim()
          ? sender.name.trim()
          : "Cloud User";

    return {
      author_id: this.stableBridgeUserId(params),
      content: typeof params.text === "string" ? params.text : "",
      server_id: DEFAULT_CENTRAL_SERVER_ID,
      raw_message: {
        text: typeof params.text === "string" ? params.text : "",
        source:
          typeof params.source === "string" && params.source.trim()
            ? params.source.trim()
            : "cloud",
      },
      metadata: {
        ...metadata,
        isDm: true,
        channelType: "DM",
        targetUserId: runtimeAgentId,
        user_display_name: displayName,
        bridgeRoomId: typeof params.roomId === "string" ? params.roomId : undefined,
      },
      source_type:
        typeof params.source === "string" && params.source.trim() ? params.source.trim() : "cloud",
    };
  }

  private getBridgeMessages(body: unknown): unknown[] {
    if (Array.isArray(body)) return body;
    if (!body || typeof body !== "object") return [];

    const root = body as Record<string, unknown>;
    const data =
      root.data && typeof root.data === "object" ? (root.data as Record<string, unknown>) : {};
    const result =
      root.result && typeof root.result === "object"
        ? (root.result as Record<string, unknown>)
        : {};

    for (const candidate of [
      root.messages,
      root.items,
      data.messages,
      data.items,
      result.messages,
      result.items,
    ]) {
      if (Array.isArray(candidate)) return candidate;
    }

    return [];
  }

  private normalizeBridgeRole(value: unknown): string | null {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    return normalized || null;
  }

  private bridgeRoleIsAgent(value: unknown): boolean {
    const role = this.normalizeBridgeRole(value);
    return (
      role === "assistant" ||
      role === "agent" ||
      role === "bot" ||
      role === "ai" ||
      role === "model" ||
      role === "assistant_message" ||
      role === "agent_message"
    );
  }

  private bridgeRoleIsUser(value: unknown): boolean {
    const role = this.normalizeBridgeRole(value);
    return (
      role === "user" ||
      role === "human" ||
      role === "client" ||
      role === "owner" ||
      role === "user_message" ||
      role === "client_message"
    );
  }

  private bridgeMessageIdMatches(value: unknown, runtimeAgentId?: string): boolean {
    return (
      typeof runtimeAgentId === "string" &&
      runtimeAgentId.length > 0 &&
      typeof value === "string" &&
      value === runtimeAgentId
    );
  }

  private nestedBridgeRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private isBridgeAgentMessage(message: Record<string, unknown>, runtimeAgentId?: string): boolean {
    if (message.isAgent === true || message.fromAgent === true || message.isBot === true) {
      return true;
    }
    if (message.isAgent === false || message.fromAgent === false || message.isBot === false) {
      return false;
    }
    const sourceType = this.normalizeBridgeRole(message.sourceType ?? message.source_type);
    if (sourceType === "agent_response") {
      return true;
    }

    for (const key of ["role", "type", "senderType", "senderRole", "authorRole", "messageType"]) {
      const value = message[key];
      if (this.bridgeRoleIsAgent(value)) return true;
      if (this.bridgeRoleIsUser(value)) return false;
    }

    for (const key of ["sender", "author", "from", "entity", "metadata"]) {
      const nested = this.nestedBridgeRecord(message[key]);
      if (!nested) continue;
      if (nested.isAgent === true || nested.fromAgent === true || nested.isBot === true)
        return true;
      if (nested.isAgent === false || nested.fromAgent === false || nested.isBot === false) {
        return false;
      }
      for (const nestedKey of ["role", "type", "senderType", "authorRole"]) {
        const nestedValue = nested[nestedKey];
        if (this.bridgeRoleIsAgent(nestedValue)) return true;
        if (this.bridgeRoleIsUser(nestedValue)) return false;
      }
      for (const nestedIdKey of ["id", "entityId", "agentId", "runtimeAgentId", "senderId"]) {
        if (this.bridgeMessageIdMatches(nested[nestedIdKey], runtimeAgentId)) return true;
      }
    }

    for (const idKey of ["entityId", "agentId", "runtimeAgentId", "senderId", "authorId"]) {
      if (this.bridgeMessageIdMatches(message[idKey], runtimeAgentId)) return true;
    }

    return false;
  }

  private extractBridgeTextValue(value: unknown, depth = 0): string | null {
    if (depth > 4) return null;
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed ? trimmed : null;
    }
    if (Array.isArray(value)) {
      const parts = value
        .map((item) => this.extractBridgeTextValue(item, depth + 1))
        .filter((text): text is string => Boolean(text));
      return parts.length > 0 ? parts.join("") : null;
    }

    const record = this.nestedBridgeRecord(value);
    if (!record) return null;

    for (const key of [
      "text",
      "fullText",
      "content",
      "message",
      "body",
      "reply",
      "response",
      "value",
    ]) {
      const text = this.extractBridgeTextValue(record[key], depth + 1);
      if (text) return text;
    }

    for (const key of ["parts", "items", "chunks"]) {
      const text = this.extractBridgeTextValue(record[key], depth + 1);
      if (text) return text;
    }

    return null;
  }

  private extractBridgeMessageText(message: Record<string, unknown>): string | null {
    for (const key of ["text", "fullText", "content", "message", "body", "reply", "response"]) {
      const text = this.extractBridgeTextValue(message[key]);
      if (text) return text;
    }
    return null;
  }

  private extractBridgeErrorMessage(body: Record<string, unknown>): string | null {
    const error = this.nestedBridgeRecord(body.error);
    if (error) {
      const message = this.extractBridgeTextValue(error.message);
      if (message) return message;
      const text = this.extractBridgeTextValue(error);
      if (text) return text;
    }
    return this.extractBridgeTextValue(body.message) ?? this.extractBridgeTextValue(body);
  }

  private extractOpenAiChatCompletionText(body: Record<string, unknown>): string | null {
    const choices = Array.isArray(body.choices) ? body.choices : [];
    for (const choice of choices) {
      const choiceRecord = this.nestedBridgeRecord(choice);
      if (!choiceRecord) continue;
      const message = this.nestedBridgeRecord(choiceRecord.message);
      if (message) {
        const content = this.extractBridgeTextValue(message.content);
        if (content) return content;
      }
      const text = this.extractBridgeTextValue(choiceRecord.text);
      if (text) return text;
    }
    return this.extractBridgeTextValue(body);
  }

  private async waitForBridgeSessionAgentReply(
    rec: AgentSandbox,
    sessionId: string,
    runtimeAgentId?: string,
  ): Promise<string | null> {
    const endpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/sessions/${encodeURIComponent(sessionId)}/messages?limit=20`,
    );

    for (let attempt = 0; attempt < 24; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await fetch(endpoint, {
        method: "GET",
        headers: this.getAgentJsonHeaders(rec),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.toReversed()) {
        const record = this.nestedBridgeRecord(message);
        if (!record || !this.isBridgeAgentMessage(record, runtimeAgentId)) continue;
        const text = this.extractBridgeMessageText(record);
        if (text) return text;
      }
    }

    return null;
  }

  private async waitForBridgeCentralChannelAgentReply(
    rec: AgentSandbox,
    channelId: string,
    runtimeAgentId?: string,
  ): Promise<string | null> {
    const endpoint = await this.getAgentApiEndpoint(
      rec,
      `/api/messaging/central-channels/${encodeURIComponent(channelId)}/messages?limit=30`,
    );

    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2_500));
      const res = await fetch(endpoint, {
        method: "GET",
        headers: this.getAgentJsonHeaders(rec),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return null;
      const body = await res.json().catch(() => ({}));
      const messages = this.getBridgeMessages(body);
      for (const message of messages.toReversed()) {
        const record = this.nestedBridgeRecord(message);
        if (!record || !this.isBridgeAgentMessage(record, runtimeAgentId)) continue;
        const text = this.extractBridgeMessageText(record);
        if (text) return text;
      }
    }

    return null;
  }

  /**
   * Proxy an HTTP request to the agent's wallet API endpoint.
   * Used by the cloud backend to forward wallet/steward requests from the dashboard.
   *
   * @param agentId  - The sandbox record ID
   * @param orgId    - The organization ID (authorization)
   * @param walletPath - Path after `/api/wallet/`, e.g. "steward-policies"
   * @param method   - HTTP method ("GET" | "POST")
   * @param body     - Optional request body (for POST requests)
   * @param query    - Optional query string (e.g. "limit=20")
   * @returns The raw fetch Response, or null if the sandbox is not running
   */
  // Allowed wallet sub-paths for proxy (prevents path traversal)
  private static readonly ALLOWED_WALLET_PATHS = new Set([
    "addresses",
    "balances",
    "steward-status",
    "steward-policies",
    "steward-tx-records",
    "steward-pending-approvals",
    "steward-approve-tx",
    "steward-deny-tx",
  ]);

  // Allowed query parameters for wallet proxy
  private static readonly ALLOWED_QUERY_PARAMS = new Set([
    "limit",
    "offset",
    "cursor",
    "type",
    "status",
  ]);

  private static readonly ALLOWED_LIFEOPS_SCHEDULE_PATHS = new Set([
    "observations",
    "merged-state",
  ]);

  private static readonly ALLOWED_LIFEOPS_SCHEDULE_QUERY_PARAMS = new Set([
    "timezone",
    "scope",
    "refresh",
  ]);

  // Anchored regex: only the agent's known plugin-workflow surface is forwarded.
  // Source of truth: plugins/plugin-workflow/src/plugin-routes.ts.
  // Intentionally additive paths (executions/:id, :id/run) are forwarded too so
  // the cloud surface is ready when the plugin mounts them; until then the
  // agent will respond 404 and the cloud relays that 404 unchanged.
  private static readonly ALLOWED_WORKFLOW_PATH_PATTERNS: readonly RegExp[] = [
    /^workflows$/,
    /^workflows\/generate$/,
    /^workflows\/resolve-clarification$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/activate$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/deactivate$/,
    /^workflows\/[a-zA-Z0-9_-]{1,128}\/run$/,
    /^executions$/,
    /^executions\/[a-zA-Z0-9_-]{1,128}$/,
    /^status$/,
  ];

  private static readonly ALLOWED_WORKFLOW_QUERY_PARAMS = new Set([
    "limit",
    "cursor",
    "status",
    "workflowId",
  ]);

  async proxyWorkflowRequest(
    agentId: string,
    orgId: string,
    workflowPath: string,
    method: "GET" | "POST" | "PUT" | "DELETE",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    if (!ElizaSandboxService.ALLOWED_WORKFLOW_PATH_PATTERNS.some((re) => re.test(workflowPath))) {
      logger.warn("[agent-sandbox] Rejected workflow proxy: invalid path", {
        agentId,
        workflowPath,
      });
      return new Response(JSON.stringify({ error: "Invalid workflow endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_WORKFLOW_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Workflow proxy: sandbox not found or not running", {
        agentId,
        orgId,
        workflowPath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Workflow proxy: no bridge_url", {
        agentId,
        status: rec.status,
        workflowPath,
      });
      return null;
    }

    try {
      const fullPath = `/api/workflow/${workflowPath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;
      const envVars = rec.environment_vars as Record<string, string> | null;
      const apiToken = envVars?.ELIZA_API_TOKEN;
      if (!apiToken) {
        logger.warn("[agent-sandbox] No ELIZA_API_TOKEN for workflow proxy", {
          agentId,
        });
      }

      const agentBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
      let endpoint: string;
      if (agentBaseDomain) {
        endpoint = `https://${agentId}.${agentBaseDomain}${fullPath}`;
      } else if (rec.web_ui_port && rec.node_id) {
        const bridgeUrl = new URL(rec.bridge_url);
        endpoint = `${bridgeUrl.protocol}//${bridgeUrl.hostname}:${rec.web_ui_port}${fullPath}`;
      } else {
        endpoint = await this.getSafeBridgeEndpoint(rec, fullPath);
      }

      const headers: Record<string, string> = { Accept: "application/json" };
      if (method !== "GET" && method !== "DELETE") {
        headers["Content-Type"] = "application/json";
      }
      if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if ((method === "POST" || method === "PUT") && body != null) {
        fetchOptions.body = body;
      }
      return await fetch(endpoint, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Workflow proxy request failed", {
        agentId,
        workflowPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async proxyWalletRequest(
    agentId: string,
    orgId: string,
    walletPath: string,
    method: "GET" | "POST",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    // Validate wallet path against whitelist (prevents path traversal)
    if (!ElizaSandboxService.ALLOWED_WALLET_PATHS.has(walletPath)) {
      logger.warn("[agent-sandbox] Rejected wallet proxy: invalid path", {
        agentId,
        walletPath,
      });
      return new Response(JSON.stringify({ error: "Invalid wallet endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Sanitize query parameters
    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Wallet proxy: sandbox not found or not running", {
        agentId,
        orgId,
        walletPath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Wallet proxy: no bridge_url", {
        agentId,
        status: rec.status,
        walletPath,
      });
      return null;
    }

    try {
      const fullPath = `/api/wallet/${walletPath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;

      // Extract API token from environment_vars
      const envVars = rec.environment_vars as Record<string, string> | null;
      const apiToken = envVars?.ELIZA_API_TOKEN;
      if (!apiToken) {
        logger.warn("[agent-sandbox] No ELIZA_API_TOKEN for wallet proxy", {
          agentId,
        });
      }

      // Prefer the public domain over internal bridge IPs (only reachable
      // from within the Hetzner network).
      const agentBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
      let endpoint: string;
      if (agentBaseDomain) {
        // Public URL: https://{agentId}.{ELIZA_CLOUD_AGENT_BASE_DOMAIN}/api/wallet/...
        endpoint = `https://${agentId}.${agentBaseDomain}${fullPath}`;
      } else if (rec.web_ui_port && rec.node_id) {
        // Internal fallback: http://{host}:{web_ui_port}/api/wallet/...
        const bridgeUrl = new URL(rec.bridge_url);
        endpoint = `${bridgeUrl.protocol}//${bridgeUrl.hostname}:${rec.web_ui_port}${fullPath}`;
      } else {
        endpoint = await this.getSafeBridgeEndpoint(rec, fullPath);
      }

      logger.info("[agent-sandbox] Wallet proxy endpoint", {
        agentId,
        endpoint: endpoint.replace(/Bearer.*/, "***"),
      });

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await fetch(endpoint, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Wallet proxy request failed", {
        agentId,
        walletPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async proxyLifeOpsScheduleRequest(
    agentId: string,
    orgId: string,
    schedulePath: string,
    method: "GET" | "POST",
    body?: string | null,
    query?: string,
  ): Promise<Response | null> {
    if (!ElizaSandboxService.ALLOWED_LIFEOPS_SCHEDULE_PATHS.has(schedulePath)) {
      logger.warn("[agent-sandbox] Rejected schedule proxy: invalid path", {
        agentId,
        schedulePath,
      });
      return new Response(JSON.stringify({ error: "Invalid schedule endpoint" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    let sanitizedQuery = "";
    if (query) {
      const params = new URLSearchParams(query);
      const filtered = new URLSearchParams();
      for (const [key, value] of params) {
        if (ElizaSandboxService.ALLOWED_LIFEOPS_SCHEDULE_QUERY_PARAMS.has(key)) {
          filtered.set(key, value);
        }
      }
      sanitizedQuery = filtered.toString();
    }

    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Schedule proxy: sandbox not found or not running", {
        agentId,
        orgId,
        schedulePath,
      });
      return null;
    }
    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Schedule proxy: no bridge_url", {
        agentId,
        status: rec.status,
        schedulePath,
      });
      return null;
    }

    try {
      const fullPath = `/api/lifeops/schedule/${schedulePath}${sanitizedQuery ? `?${sanitizedQuery}` : ""}`;
      const envVars = rec.environment_vars as Record<string, string> | null;
      const apiToken = envVars?.ELIZA_API_TOKEN;
      if (!apiToken) {
        logger.warn("[agent-sandbox] No ELIZA_API_TOKEN for schedule proxy", {
          agentId,
        });
      }

      const agentBaseDomain = process.env.ELIZA_CLOUD_AGENT_BASE_DOMAIN;
      let endpoint: string;
      if (agentBaseDomain) {
        endpoint = `https://${agentId}.${agentBaseDomain}${fullPath}`;
      } else if (rec.web_ui_port && rec.node_id) {
        const bridgeUrl = new URL(rec.bridge_url);
        endpoint = `${bridgeUrl.protocol}//${bridgeUrl.hostname}:${rec.web_ui_port}${fullPath}`;
      } else {
        endpoint = await this.getSafeBridgeEndpoint(rec, fullPath);
      }

      const headers: Record<string, string> = {
        Accept: "application/json",
      };
      if (method === "POST") {
        headers["Content-Type"] = "application/json";
      }
      if (apiToken) {
        headers.Authorization = `Bearer ${apiToken}`;
      }
      const fetchOptions: RequestInit = {
        method,
        headers,
        signal: AbortSignal.timeout(30_000),
      };
      if (method === "POST" && body != null) {
        fetchOptions.body = body;
      }
      return await fetch(endpoint, fetchOptions);
    } catch (error) {
      logger.warn("[agent-sandbox] Schedule proxy request failed", {
        agentId,
        schedulePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async bridgeStream(agentId: string, orgId: string, rpc: BridgeRequest): Promise<Response | null> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec) {
      logger.warn("[agent-sandbox] Bridge stream to non-running sandbox", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    const params =
      rpc.params && typeof rpc.params === "object" ? (rpc.params as Record<string, unknown>) : {};
    const fallbackText = this.buildBridgeNoReplyFallbackText(params);

    if (rec.execution_tier === "shared") {
      const sharedResponse = await this.bridgeSharedMessageSend(rec, rpc);
      const text = sharedResponse.result?.text;
      if (typeof text === "string" && text.trim()) {
        return this.createBridgeSseTextResponse(text);
      }
      if (sharedResponse.error) {
        // A credit-reserve rejection is not a stream failure — no SSE bytes
        // exist yet, so throw the canonical typed 402 for the route boundary
        // to translate (messages/stream → 402 JSON; agent stream routes'
        // errorToResponse / control-plane errorBody map ApiError natively).
        // Wrapping it in an SSE error frame here would bury a permanent
        // add-credits condition inside a 200 stream.
        if (sharedResponse.error.code === BRIDGE_INSUFFICIENT_CREDITS_CODE) {
          throw new InsufficientCreditsApiError(sharedResponse.error.message);
        }
        return this.createBridgeSseErrorResponse(sharedResponse.error.message);
      }
      return fallbackText ? this.createBridgeSseTextResponse(fallbackText) : null;
    }

    if (!rec.bridge_url) {
      logger.warn("[agent-sandbox] Bridge stream to running sandbox without bridge URL", {
        agentId,
        method: rpc.method,
      });
      return null;
    }

    try {
      const conversationId = await this.createBridgeConversation(rec, params);
      const bridgeEndpoint = await this.getAgentApiEndpoint(
        rec,
        `/api/conversations/${encodeURIComponent(conversationId)}/messages/stream`,
      );
      const res = await fetch(bridgeEndpoint, {
        method: "POST",
        headers: this.getAgentJsonHeaders(rec),
        body: JSON.stringify(this.buildBridgeConversationMessageBody(params)),
        signal: AbortSignal.timeout(120_000),
      });
      if (res.ok) return this.normalizeBridgeSseResponse(res);
      if (res.status !== 404) {
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          status: res.status,
        });
      }
    } catch (error) {
      if (!(error instanceof BridgeRouteUnavailableError)) {
        logger.warn("[agent-sandbox] Bridge stream conversation request failed", {
          agentId,
          method: rpc.method,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    try {
      return await this.bridgeOpenAiChatCompletionSse(rec, params);
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge stream compatibility request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    try {
      const centralResponse = await this.bridgeCentralChannelMessageSend(rec, rpc, params);
      if (this.bridgeResponseHasText(centralResponse)) {
        return this.createBridgeSseTextResponse(centralResponse.result!.text as string);
      }
      if (centralResponse.error) {
        return this.createBridgeSseErrorResponse(centralResponse.error.message);
      }
      if (fallbackText) {
        return this.createBridgeSseTextResponse(fallbackText);
      }
    } catch (error) {
      logger.warn("[agent-sandbox] Bridge stream central-channel request failed", {
        agentId,
        method: rpc.method,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (fallbackText) {
      return this.createBridgeSseTextResponse(fallbackText);
    }

    return null;
  }

  private async bridgeOpenAiChatCompletionSse(
    rec: AgentSandbox,
    params: Record<string, unknown>,
  ): Promise<Response | null> {
    const { body, status } = await this.requestBridgeOpenAiChatCompletion(rec, params);
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      return this.createBridgeSseErrorResponse(
        this.extractBridgeErrorMessage(body) ?? `Bridge returned HTTP ${status}`,
      );
    }

    const text = this.extractOpenAiChatCompletionText(body);
    if (!text) {
      return null;
    }
    return this.createBridgeSseTextResponse(text);
  }

  private createBridgeSseTextResponse(text: string): Response {
    const messageId = crypto.randomUUID();
    const chunk = {
      messageId,
      chunk: text,
      text,
      timestamp: Date.now(),
    };
    return new Response(
      `event: chunk\ndata: ${JSON.stringify(chunk)}\n\nevent: done\ndata: ${JSON.stringify({ messageId, text })}\n\n`,
      {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
        },
      },
    );
  }

  normalizeBridgeSseResponse(response: Response): Response {
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("text/event-stream") || !response.body) {
      return response;
    }

    const messageId = crypto.randomUUID();
    // Accumulate across frames: a delta-v2 agent (client `streamProtocol` can
    // ride through the bridge to it) ships bare `{type:"token",text}` deltas and
    // resends `fullText` only on a periodic snapshot, so the downstream
    // `fullText`/done text must be rebuilt here, not read off each frame.
    let accumulated = "";
    let pending = "";
    const findEventBreak = (value: string) => {
      const lfBreak = value.indexOf("\n\n");
      const crlfBreak = value.indexOf("\r\n\r\n");
      if (lfBreak === -1 && crlfBreak === -1) return null;
      if (lfBreak === -1) return { index: crlfBreak, length: 4 };
      if (crlfBreak === -1) return { index: lfBreak, length: 2 };
      return lfBreak < crlfBreak ? { index: lfBreak, length: 2 } : { index: crlfBreak, length: 4 };
    };
    const emitFrame = (frame: string, controller: TransformStreamDefaultController<string>) => {
      if (!frame.trim()) return;
      const dataLine = frame.split(/\r?\n/).find((line) => line.startsWith("data:"));
      if (!dataLine) {
        controller.enqueue(`${frame}\n\n`);
        return;
      }
      try {
        const data = JSON.parse(dataLine.slice(5).trimStart());
        if (data?.type === "token") {
          const delta = typeof data.text === "string" ? data.text : "";
          accumulated = typeof data.fullText === "string" ? data.fullText : accumulated + delta;
          controller.enqueue(
            `event: chunk\ndata: ${JSON.stringify({
              messageId,
              chunk: delta,
              text: delta,
              fullText: accumulated,
              timestamp: Date.now(),
            })}\n\n`,
          );
          return;
        }
        if (data?.type === "done") {
          controller.enqueue(
            `event: done\ndata: ${JSON.stringify({
              messageId,
              text: typeof data.fullText === "string" ? data.fullText : accumulated,
            })}\n\n`,
          );
          return;
        }
      } catch {
        // error-policy:J3 untrusted SSE frames are invalid for normalization and pass through unchanged.
      }
      controller.enqueue(`${frame}\n\n`);
    };
    const stream = response.body
      .pipeThrough(new TextDecoderStream())
      .pipeThrough(
        new TransformStream<string, string>({
          transform: (chunk, controller) => {
            pending += chunk;
            let eventBreak = findEventBreak(pending);
            while (eventBreak) {
              const frame = pending.slice(0, eventBreak.index);
              pending = pending.slice(eventBreak.index + eventBreak.length);
              emitFrame(frame, controller);
              eventBreak = findEventBreak(pending);
            }
          },
          flush: (controller) => {
            if (pending.trim()) emitFrame(pending, controller);
            pending = "";
          },
        }),
      )
      .pipeThrough(new TextEncoderStream());

    return new Response(stream, {
      status: response.status,
      headers: response.headers,
    });
  }

  private createBridgeSseErrorResponse(message: string): Response {
    return new Response(`event: error\ndata: ${JSON.stringify({ message })}\n\n`, {
      status: 200,
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
      },
    });
  }

  // Snapshots

  async snapshot(
    agentId: string,
    orgId: string,
    type: AgentBackupSnapshotType = "manual",
  ): Promise<SnapshotResult> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) return { success: false, error: "Sandbox is not running" };

    let stateData: AgentBackupStateData;
    let sizeBytes: number;
    try {
      ({ stateData, sizeBytes } = await this.fetchSnapshotState(rec));
    } catch (error) {
      // A bridge that lacks /api/snapshot (V2 image) returns the sentinel; an
      // auto backup against it is a benign skip, so surface it as a result the
      // snapshot job recognizes instead of a thrown, retried failure. All other
      // errors (real fetch/transport failures) still propagate.
      const message = error instanceof Error ? error.message : String(error);
      if (message === SNAPSHOT_ENDPOINT_UNSUPPORTED) {
        return { success: false, error: SNAPSHOT_ENDPOINT_UNSUPPORTED };
      }
      throw error;
    }

    if (type === "pre-upgrade" && !stateData.manifest) {
      return {
        success: false,
        error: "Pre-upgrade snapshot did not include a full-agent manifest",
      };
    }

    const backup = await agentSandboxesRepository.createBackup(
      await this.buildBackupInput(rec.id, type, stateData, sizeBytes),
    );

    await agentSandboxesRepository.update(rec.id, {
      last_backup_at: new Date(),
    });
    await agentSandboxesRepository.pruneBackups(rec.id, MAX_BACKUPS);
    logger.info("[agent-sandbox] Backup created", {
      agentId,
      type,
      kind: backup.backup_kind,
      bytes: backup.size_bytes,
    });
    return { success: true, backup };
  }

  /**
   * Decide whether a new snapshot of `stateData` is stored as a full backup or
   * an incremental delta against the latest backup, and build the insert row.
   * Falls back to a full backup whenever there is no parent, the parent chain
   * can't be reconstructed, or the delta isn't worth it (see
   * `planIncrementalBackup`). Full-backup behaviour is byte-identical to the
   * pre-incremental path, so existing flows are unaffected.
   */
  private async buildBackupInput(
    sandboxRecordId: string,
    type: AgentBackupSnapshotType,
    stateData: AgentBackupStateData,
    sizeBytes: number,
  ): Promise<NewAgentSandboxBackup> {
    const contentHash = computeStateHash(stateData);
    const latest = await agentSandboxesRepository.getLatestBackup(sandboxRecordId);
    if (latest) {
      try {
        const baseState = await agentSandboxesRepository.getReconstructedBackupState(latest.id);
        if (baseState) {
          const all = await agentSandboxesRepository.listBackups(sandboxRecordId, 1000);
          const nodes = all.map((b) => ({
            id: b.id,
            backupKind: b.backup_kind,
            parentBackupId: b.parent_backup_id,
            createdAtMs: b.created_at.getTime(),
          }));
          const chainDepth = incrementalChainDepth(nodes, latest.id);
          const plan = planIncrementalBackup({ base: baseState, next: stateData, chainDepth });
          if (plan.kind === "incremental") {
            return {
              sandbox_record_id: sandboxRecordId,
              snapshot_type: type,
              // The state_data jsonb holds a BackupDelta for incremental rows.
              state_data: plan.delta,
              size_bytes: estimateDeltaBytes(plan.delta),
              backup_kind: "incremental",
              parent_backup_id: latest.id,
              content_hash: contentHash,
            };
          }
        }
      } catch (error) {
        logger.warn("[agent-sandbox] Incremental planning failed; storing full backup", {
          sandboxRecordId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return {
      sandbox_record_id: sandboxRecordId,
      snapshot_type: type,
      state_data: stateData,
      size_bytes: sizeBytes,
      backup_kind: "full",
      content_hash: contentHash,
    };
  }

  async restore(agentId: string, orgId: string, backupId?: string): Promise<SnapshotResult> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec) return { success: false, error: "Agent not found" };

    const backup = backupId
      ? await agentSandboxesRepository.getBackupById(backupId)
      : await agentSandboxesRepository.getLatestBackup(rec.id);
    if (!backup) return { success: false, error: "No backup found" };

    // Verify backup belongs to this sandbox to prevent cross-agent restore
    if (backup.sandbox_record_id !== rec.id) {
      return { success: false, error: "Backup does not belong to this agent" };
    }

    if (rec.status !== "running" && backupId) {
      const latestBackup = await agentSandboxesRepository.getLatestBackup(rec.id);
      if (!latestBackup || backup.id !== latestBackup.id) {
        return {
          success: false,
          error: "Stopped agents can only restore the latest backup",
        };
      }
    }

    if (rec.status === "running" && rec.bridge_url) {
      const restoreState = await agentSandboxesRepository.getReconstructedBackupState(backup.id);
      if (!restoreState) {
        return {
          success: false,
          error: `Backup ${backup.id} could not be reconstructed`,
        };
      }
      await this.pushState(rec, restoreState);
      return { success: true, backup };
    }

    const prov = await this.provision(agentId, orgId);
    return prov.success ? { success: true, backup } : { success: false, error: prov.error };
  }

  async listBackups(agentId: string, orgId: string): Promise<AgentSandboxBackupMetadata[]> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    return rec ? agentSandboxesRepository.listBackupMetadata(rec.id) : [];
  }

  // Heartbeat

  async heartbeat(agentId: string, orgId: string): Promise<boolean> {
    const rec = await agentSandboxesRepository.findRunningSandbox(agentId, orgId);
    if (!rec?.bridge_url) return false;

    const reachable = await this.probeBridgeHealth(rec);

    if (!reachable) {
      // Hysteresis: one failed cycle is not enough to evict. last_heartbeat_at
      // is bumped only on success, so its age is how long the agent has been
      // continuously unreachable. Stay running inside the grace window (the next
      // cycle's retry re-warms the path); only disconnect once unreachable past
      // it.
      const lastOkMs = rec.last_heartbeat_at
        ? new Date(rec.last_heartbeat_at).getTime()
        : Date.now();
      const downForMs = Date.now() - lastOkMs;
      if (downForMs < HEARTBEAT_DISCONNECT_AFTER_MS) {
        logger.warn("[agent-sandbox] Heartbeat miss within grace window, keeping running", {
          agentId,
          downForMs,
        });
        return false;
      }
      // Past-grace miss: before disconnecting (which reprovisions — destroying
      // and rebuilding the container), check whether the container is alive but
      // its stored tailnet IP went stale, and repair the columns in place. The
      // repair heals every consumer at once (this probe, the agent-router, the
      // public proxy) because they all read the same columns.
      const reconcile = await this.reconcileStaleTailnetIp(rec);
      if (reconcile.outcome === "repaired") {
        await agentSandboxesRepository.update(rec.id, {
          headscale_ip: reconcile.headscaleIp,
          bridge_url: reconcile.bridgeUrl,
          last_heartbeat_at: new Date(),
          error_count: 0,
        });
        logger.info(
          `[agent-sandbox] Reconciled stale tailnet IP ${rec.headscale_ip}→${reconcile.headscaleIp} for agent ${agentId}`,
        );
        return true;
      }
      if (reconcile.outcome === "ip-unresolvable") {
        // Docker reports the container healthy but the node cannot tell us its
        // current tailnet IP — indistinguishable from a transient SSH outage,
        // so disconnecting now could destroy a healthy paid container. Ratchet
        // error_count and only escalate once the cap of consecutive cycles is
        // hit, so an agent that stays unresolvable still reaches the
        // disconnect → reprovision self-heal instead of sitting unreachable
        // at "running" forever.
        const unresolvedCycles = (rec.error_count ?? 0) + 1;
        if (unresolvedCycles < IP_RECONCILE_MAX_UNRESOLVED_CYCLES) {
          await agentSandboxesRepository.update(rec.id, {
            error_count: unresolvedCycles,
          });
          logger.warn(
            "[agent-sandbox] Tailnet IP unresolvable for docker-healthy agent, deferring disconnect",
            { agentId, unresolvedCycles },
          );
          return false;
        }
      }
      logger.warn("[agent-sandbox] Heartbeat failed past grace window, marking disconnected", {
        agentId,
        downForMs,
        reconcileOutcome: reconcile.outcome,
      });
      await agentSandboxesRepository.update(rec.id, {
        status: "disconnected",
      });
      return false;
    }
    await agentSandboxesRepository.update(rec.id, {
      last_heartbeat_at: new Date(),
      // Reset the unresolvable-cycle grace counter on any clean heartbeat so the
      // "escalate after 3 consecutive unresolvable cycles" window measures from
      // the last healthy beat, not a stale prior error_count from an old episode.
      error_count: 0,
    });
    return true;
  }

  /**
   * Probe the agent's bridge `/api/health` over the headscale tailnet with
   * retries. Shared by `heartbeat` (running agents) and `recoverDisconnected`
   * (disconnected always-on agents).
   *
   * The first attempt re-warms a cold tailnet path, so a single miss does not
   * mean the agent is down. Liveness MUST dial the BRIDGE port: the container
   * serves its full HTTP API there (and `/api/health` unauthed — the same
   * endpoint provisioning's health probe passes on); `web_ui_port` is a
   * host-only docker mapping NOT reachable over the tailnet. This exact form is
   * verified live in prod (a dedicated-always agent holds `running` and its
   * subdomain proxies 200/401).
   */
  private async probeBridgeHealth(
    rec: Pick<AgentSandbox, "id" | "environment_vars" | "bridge_url">,
  ): Promise<boolean> {
    if (!rec.bridge_url) return false;
    const endpoint = new URL("/api/health", rec.bridge_url).toString();
    for (let attempt = 0; attempt < HEARTBEAT_PROBE_ATTEMPTS; attempt++) {
      if (attempt > 0) {
        await new Promise((resolve) => setTimeout(resolve, HEARTBEAT_PROBE_RETRY_MS));
      }
      try {
        const res = await fetch(endpoint, {
          method: "GET",
          headers: this.getAgentJsonHeaders(rec),
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) return true;
      } catch (error) {
        logger.debug("[agent-sandbox] Bridge health probe attempt failed, retrying", {
          agentId: rec.id,
          attempt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return false;
  }

  /**
   * SSH client for the docker node hosting the agent's container. Returns null
   * when the node cannot be located — the reconcile path treats that as "no
   * signal", never as evidence either way.
   */
  private async getNodeSshForAgent(
    rec: Pick<ReconcilableSandbox, "id" | "node_id">,
  ): Promise<DockerSSHClient | null> {
    if (!rec.node_id) return null;
    // error-policy:J4 best-effort node resolve — a DB/SSH-config failure here is
    // "cannot determine", not a heartbeat kill; the caller decides how to degrade.
    try {
      const node = await dockerNodesRepository.findByNodeId(rec.node_id);
      if (!node) return null;
      return DockerSSHClient.getClient(
        node.hostname,
        node.ssh_port,
        node.host_key_fingerprint ?? undefined,
        node.ssh_user,
      );
    } catch (error) {
      logger.debug("[agent-sandbox] Failed to resolve docker node for reconcile", {
        agentId: rec.id,
        nodeId: rec.node_id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Node-side docker health for the agent's container. This is the authority
   * that distinguishes a dead container (safe to disconnect → reprovision)
   * from a live one whose stored tailnet IP went stale (must be repaired, not
   * destroyed).
   */
  private async isContainerDockerHealthy(rec: ReconcilableSandbox): Promise<boolean> {
    if (!rec.container_name) return false;
    const ssh = await this.getNodeSshForAgent(rec);
    if (!ssh) return false;
    // error-policy:J4 best-effort probe — an exec failure yields "not proven
    // healthy" (falls through to the existing disconnect self-heal), never a throw.
    try {
      const status = (
        await ssh.exec(
          `docker inspect --format '{{.State.Health.Status}}' ${shellQuote(rec.container_name)}`,
          RECONCILE_SSH_CMD_TIMEOUT_MS,
        )
      ).trim();
      return status === "healthy";
    } catch (error) {
      logger.debug("[agent-sandbox] Docker health inspect failed during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  /**
   * Resolve the container's CURRENT tailnet IP authoritatively from the node:
   * `tailscale --socket=/tmp/tailscaled.sock ip -4` inside the container is the same source the container
   * registered with, so it reflects the post-restart node key/IP — unlike the
   * stored headscale_ip, which is a provision-time snapshot.
   */
  private async resolveCurrentAgentTailnetIp(rec: ReconcilableSandbox): Promise<string | null> {
    if (!rec.container_name) return null;
    const ssh = await this.getNodeSshForAgent(rec);
    if (!ssh) return null;
    // error-policy:J4 best-effort resolve — a failed resolve returns null (no
    // positive signal), never throws; the caller ratchets toward disconnect.
    try {
      const out = await ssh.exec(
        `docker exec ${shellQuote(rec.container_name)} tailscale --socket=/tmp/tailscaled.sock ip -4`,
        RECONCILE_SSH_CMD_TIMEOUT_MS,
      );
      // First 100.64.0.0/10-shaped line; the CLI can also print IPv6 lines.
      const ip = out
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.startsWith("100."));
      return ip && isIP(ip) === 4 ? ip : null;
    } catch (error) {
      logger.debug("[agent-sandbox] Current tailnet IP resolve failed during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Attempt to reconcile a bridge-probe miss as a stale stored tailnet IP.
   * Containers do not persist tailscale node state, so a restart mints a fresh
   * node key and headscale assigns the next IP — leaving headscale_ip /
   * bridge_url pointing at a dead address that EVERY consumer reads (the
   * heartbeat probe, the agent-router's subdomain resolution, and therefore
   * the public dedicated-agent proxy). Repairing the columns heals them all;
   * anything unrepairable falls back to the existing disconnect → reprovision
   * self-heal. The repaired bridge_url keeps the stored scheme/port and swaps
   * only the host — the same `http://<tailnetIp>:<containerPort>` shape the
   * provisioner writes.
   */
  private async reconcileStaleTailnetIp(
    rec: ReconcilableSandbox,
  ): Promise<TailnetIpReconcileResult> {
    if (!(await this.isContainerDockerHealthy(rec))) return { outcome: "container-dead" };
    const currentIp = await this.resolveCurrentAgentTailnetIp(rec);
    if (!currentIp) return { outcome: "ip-unresolvable" };
    // Same IP as stored = nothing to repair: the miss is genuine
    // unreachability at the correct address, so the dead-agent path applies.
    if (!rec.bridge_url || currentIp === rec.headscale_ip) return { outcome: "unrepairable" };

    let bridgeUrl: string;
    try {
      const repaired = new URL(rec.bridge_url);
      repaired.hostname = currentIp;
      bridgeUrl = repaired.origin;
    } catch (error) {
      // error-policy:J4 a malformed stored bridge_url cannot be repaired in
      // place; degrade to the existing disconnect → reprovision self-heal.
      logger.warn("[agent-sandbox] Stored bridge_url unparsable during reconcile", {
        agentId: rec.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return { outcome: "unrepairable" };
    }

    // Only a live answer on the repaired address proves the new IP is the
    // container we think it is — never persist an unverified repair.
    const reachable = await this.probeBridgeHealth({ ...rec, bridge_url: bridgeUrl });
    if (!reachable) return { outcome: "unrepairable" };
    return { outcome: "repaired", headscaleIp: currentIp, bridgeUrl };
  }

  private async verifyUpgradeRuntimeHealth(args: {
    agent: Pick<AgentSandbox, "id" | "environment_vars">;
    bridgeUrl: string;
  }): Promise<{ success: true } | { success: false; error: string }> {
    let endpoint: string;
    try {
      endpoint = new URL("/api/health", args.bridgeUrl).toString();
    } catch (error) {
      return {
        success: false,
        error: `invalid bridge URL: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    try {
      const res = await withTimeout(
        fetch(endpoint, {
          method: "GET",
          headers: {
            ...this.getAgentJsonHeaders(args.agent),
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS),
        }),
        UPGRADE_RUNTIME_HEALTH_GATE_TIMEOUT_MS + 1_000,
        "blue runtime health gate",
      );
      if (!res.ok) {
        return {
          success: false,
          error: `/api/health returned HTTP ${res.status}`,
        };
      }

      const health = (await res.json()) as AgentRuntimeHealthPayload;
      const failures: string[] = [];
      if (health.ready !== true) {
        failures.push(`ready=${String(health.ready)}`);
      }
      if (health.runtime !== "ok") {
        failures.push(`runtime=${String(health.runtime)}`);
      }
      if (health.database !== "ok") {
        failures.push(`database=${String(health.database)}`);
      }
      const rawFailedPlugins = health.plugins?.failed ?? 0;
      const failedPlugins =
        typeof rawFailedPlugins === "number" ? rawFailedPlugins : Number(rawFailedPlugins);
      if (!Number.isFinite(failedPlugins)) {
        failures.push(`plugins.failed=${String(rawFailedPlugins)}`);
      } else if (failedPlugins > 0) {
        failures.push(`plugins.failed=${failedPlugins}`);
      }
      const startupError =
        typeof health.startup?.lastError === "string" && health.startup.lastError.trim()
          ? health.startup.lastError.trim()
          : null;
      if (startupError) {
        failures.push(`startup.lastError=${startupError}`);
      }

      if (failures.length > 0) {
        return {
          success: false,
          error: `/api/health not ready (${failures.join(", ")})`,
        };
      }
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Reconcile a recoverable always-on (paid) agent back to health. A
   * `dedicated-always` agent is contractually meant to stay up, so the recovery
   * cycle calls this to self-heal a transient drop: re-probe the bridge and, if
   * the container answers, flip it straight back to `running` (the agent-router
   * only routes `running`, so this also restores its subdomain). Blue/green
   * swaps can also leave a healthy bridge behind a stale `error` row; treat that
   * the same as `disconnected`, but only after the live bridge answers. If it
   * stays unreachable the caller re-provisions it. The guarded compare-and-set
   * write (not a blind update-by-id) makes this safe to run concurrently with
   * the heartbeat cycle AND with shutdown/delete/provision: the read -> probe ->
   * write window spans seconds, so we only flip a row that is STILL in the
   * probed recoverable status at write time.
   */
  async recoverDisconnected(
    agentId: string,
    orgId: string,
  ): Promise<"recovered" | "unreachable" | "gone"> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec || (rec.status !== "disconnected" && rec.status !== "error")) return "gone";
    const recoverableStatus = rec.status;
    const reachable = await this.probeBridgeHealth(rec);
    if (!reachable) {
      // The stored bridge_url may simply be stale (container restart → new
      // tailnet IP) rather than the container being down. Repair-and-reprobe
      // before declaring it unreachable, so recovery does not reprovision —
      // destroy and rebuild — a healthy container that only needs its ingress
      // columns fixed. Anything unrepairable stays "unreachable" and
      // reprovisions exactly as before.
      const reconcile = await this.reconcileStaleTailnetIp(rec);
      if (reconcile.outcome !== "repaired") return "unreachable";
      // Same guarded CAS as the plain recovery flip below: only revive a row
      // that is STILL in the probed recoverable status, then persist the
      // repaired ingress columns on the now-running row.
      const revived = await agentSandboxesRepository.markReconnectedFromDisconnected(
        rec.id,
        recoverableStatus,
      );
      if (!revived) return "gone";
      await agentSandboxesRepository.update(rec.id, {
        headscale_ip: reconcile.headscaleIp,
        bridge_url: reconcile.bridgeUrl,
        error_count: 0,
      });
      logger.info(
        `[agent-sandbox] Reconciled stale tailnet IP ${rec.headscale_ip}→${reconcile.headscaleIp} for agent ${agentId}`,
      );
      return "recovered";
    }
    // Guarded CAS: the row can move to deletion_pending / stopped (which nulls
    // bridge_url) / provisioning during the multi-second probe. Only flip it if
    // it is STILL disconnected with a live bridge — otherwise we'd resurrect a
    // being-deleted agent or wedge a stopped one at `running` with a dead bridge.
    const restored = await agentSandboxesRepository.markReconnectedFromDisconnected(
      rec.id,
      recoverableStatus,
    );
    if (!restored) return "gone";
    logger.info("[agent-sandbox] Recovered agent back to running", {
      agentId,
    });
    return "recovered";
  }

  /**
   * Reconcile a row WEDGED in `provisioning` whose container may actually be
   * healthy — the readiness-probe false-negative split-brain (#15310 #6). The
   * Worker-side cleanup cron can only mark such rows `error` (no SSH); THIS runs
   * on the daemon, which can re-probe the container node-side and, when it is
   * genuinely healthy, flip the row straight to `running` instead of failing a
   * live agent.
   *
   * Outcomes:
   *   - `recovered` — the container re-probed healthy and the row was CAS-flipped
   *     to `running`.
   *   - `unresolved` — the probe still could not confirm health (transport
   *     unresolved or genuinely not-ready). Left untouched for the next pass
   *     (or, eventually, the Worker cron's error mark). NEVER destroys the
   *     container: a wrong teardown here re-creates the very bug.
   *   - `gone` — the row moved on (no longer `provisioning`, deleted, or lost
   *     its container) during the multi-second probe; nothing to do.
   */
  async reconcileStuckProvisioning(
    agentId: string,
    orgId: string,
  ): Promise<"recovered" | "unresolved" | "gone"> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec || rec.status !== "provisioning" || !rec.sandbox_id) return "gone";

    const provider = await this.getProvider();
    const handle: SandboxHandle = {
      sandboxId: rec.sandbox_id,
      bridgeUrl: rec.bridge_url ?? "",
      healthUrl: rec.health_url ?? "",
      metadata: rec.headscale_ip ? { headscaleIp: rec.headscale_ip } : undefined,
    };

    let healthy = false;
    try {
      healthy = provider.checkHealthDetailed
        ? (await provider.checkHealthDetailed(handle)).ready
        : await provider.checkHealth(handle);
    } catch (error) {
      // A probe that throws is "no signal" — leave the row for the next pass,
      // never condemn or resurrect on an errored probe.
      logger.debug("[agent-sandbox] Stuck-provisioning re-probe threw; leaving row", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
      return "unresolved";
    }

    if (!healthy) return "unresolved";

    // Guarded CAS: only flip if still `provisioning` with a live container and
    // no active provision job racing it (see markRunningFromProvisioning).
    const flipped = await agentSandboxesRepository.markRunningFromProvisioning(rec.id);
    if (!flipped) return "gone";
    logger.info(
      "[agent-sandbox] Reconciled wedged provisioning row to running (container re-probed healthy)",
      { agentId },
    );
    return "recovered";
  }

  // Shutdown

  async shutdown(agentId: string, orgId: string): Promise<{ success: boolean; error?: string }> {
    let snapshotAgentId: string | null = null;
    let preShutdownSnapshot: {
      stateData: AgentBackupStateData;
      sizeBytes: number;
      bridgeUrl: string;
    } | null = null;

    const snapshotSource = await this.getAgentForWrite(agentId, orgId);
    if (snapshotSource?.status === "running" && snapshotSource.bridge_url) {
      preShutdownSnapshot = await this.fetchSnapshotState(snapshotSource).catch((error) => {
        logger.warn("[agent-sandbox] Pre-shutdown backup fetch failed", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
        return null;
      });
    }

    const result = await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);

      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec) return { success: false, error: "Agent not found" } as const;

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return {
          success: false,
          error: "Agent provisioning is in progress",
        } as const;
      }

      if (
        preShutdownSnapshot &&
        rec.status === "running" &&
        rec.bridge_url === preShutdownSnapshot.bridgeUrl
      ) {
        await this.persistSnapshotWithinTransaction(
          tx,
          rec.id,
          rec.organization_id,
          "pre-shutdown",
          preShutdownSnapshot.stateData,
          preShutdownSnapshot.sizeBytes,
        );
      }

      if (rec.sandbox_id) {
        await (await this.getProvider()).stop(rec.sandbox_id).catch((e) => {
          logger.warn("[agent-sandbox] Stop failed during shutdown", {
            sandboxId: rec.sandbox_id,
            status: rec.status,
            error: e instanceof Error ? e.message : String(e),
          });
        });
      }

      await tx.execute(sql`
        UPDATE ${agentSandboxes}
        SET
          status = 'stopped',
          sandbox_id = NULL,
          bridge_url = NULL,
          health_url = NULL,
          updated_at = NOW()
        WHERE id = ${rec.id}
      `);

      snapshotAgentId = rec.id;
      return { success: true } as const;
    });

    if (result.success && snapshotAgentId) {
      await agentSandboxesRepository.pruneBackups(snapshotAgentId, MAX_BACKUPS).catch((error) => {
        logger.warn("[agent-sandbox] Backup pruning failed after shutdown", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
      logger.info("[agent-sandbox] Shutdown complete", { agentId });
    }

    return result;
  }

  /**
   * Daemon-side handler for the `agent_suspend` job. Calls the provider's
   * `stop()` (which removes the container and frees the node slot), flips the
   * DB row to `stopped`, and clears bridge/health URLs — but keeps `sandbox_id`
   * and the per-tenant managed DB so a subsequent `agent_resume` re-provisions
   * against the retained state. Replaces the Worker-callable `shutdown()` path
   * which silently failed to stop the container (Workers can't SSH).
   */
  async executeSuspend(
    agentId: string,
    orgId: string,
  ): Promise<{ success: boolean; containerStopped: boolean; error?: string }> {
    return await dbWrite.transaction(async (tx) => {
      await this.lockLifecycle(tx, agentId, orgId);
      const rec = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
      if (!rec || this.isAwaitingDeletion(rec.status))
        return {
          success: false,
          containerStopped: false,
          error: "Agent not found",
        } as const;

      const hasActiveProvisionJob = await this.hasActiveProvisionJobTx(tx, agentId, orgId);
      if (rec.status === "provisioning" || hasActiveProvisionJob) {
        return {
          success: false,
          containerStopped: false,
          error: "Agent provisioning is in progress",
        } as const;
      }
      if (rec.status === "stopped") return { success: true, containerStopped: true } as const;

      let containerStopped = false;
      if (rec.sandbox_id) {
        try {
          await (await this.getProvider()).stop(rec.sandbox_id);
          containerStopped = true;
        } catch (e) {
          if (this.isIgnorableSandboxStopError(e)) {
            containerStopped = true;
            logger.info("[agent-sandbox] Sandbox already absent during suspend", {
              sandboxId: rec.sandbox_id,
              error: e instanceof Error ? e.message : String(e),
            });
          } else {
            return {
              success: false,
              containerStopped: false,
              error: e instanceof Error ? e.message : String(e),
            } as const;
          }
        }
      } else {
        containerStopped = true;
      }

      await tx.execute(sql`
        UPDATE ${agentSandboxes}
        SET status = 'stopped', bridge_url = NULL, health_url = NULL, updated_at = NOW()
        WHERE id = ${rec.id}
      `);
      return { success: true, containerStopped } as const;
    });
  }

  /**
   * A row in `deletion_pending` / `deletion_failed` is logically gone — an
   * agent_delete job owns it. Bringing it back up (resume / wake / restart)
   * would resurrect a container we are tearing down, so these states are
   * treated exactly like a missing row: the daemon handler maps "Agent not
   * found" to a terminal no-op instead of resurrecting the agent.
   */
  private isAwaitingDeletion(status: AgentSandboxStatus): boolean {
    return status === "deletion_pending" || status === "deletion_failed";
  }

  /**
   * Daemon-side handler for the `agent_resume` job. Delegates to
   * `provision()` which restores `bridge_url` / `health_url` from the
   * provider's sandbox handle and reuses the existing shared DB
   * (`sandbox_id` is retained across suspend). `provision()` acquires
   * its own advisory lock, so two concurrent resume jobs serialize.
   *
   * A future fast path will `docker start` the existing container (~5s)
   * when the provider exposes a standalone `start()` method that
   * returns a fresh handle — today the only way to get `bridgeUrl` /
   * `healthUrl` back is via the create-or-restart flow inside
   * `provision()`, so we always pay that path.
   */
  async executeResume(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerStarted: boolean;
    reprovisioned: boolean;
    error?: string;
  }> {
    // Read from the PRIMARY: a replica-lagged "Agent not found" / stale status
    // here would turn a legitimate resume into a terminal no-op (the daemon
    // maps "Agent not found" to completed), silently dropping the request. The
    // existence + deletion-state check must be authoritative.
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec || this.isAwaitingDeletion(rec.status))
      return {
        success: false,
        containerStarted: false,
        reprovisioned: false,
        error: "Agent not found",
      };
    if (rec.status === "running")
      return { success: true, containerStarted: true, reprovisioned: false };

    const provisionResult = await this.provision(agentId, orgId);
    if (!provisionResult.success) {
      return {
        success: false,
        containerStarted: false,
        reprovisioned: true,
        error: provisionResult.error,
      };
    }
    return { success: true, containerStarted: true, reprovisioned: true };
  }

  /**
   * Daemon-side handler for the `agent_sleep` job — deep, cold suspend.
   *
   * Both suspend and sleep drop the container + free the node slot; unlike
   * `agent_suspend` (which keeps the row's `sandbox_id` + managed DB for an
   * in-place resume), sleep frees the compute identity entirely:
   *   1. Capture a durable backup. A live `/api/snapshot` pull when the agent
   *      is reachable, otherwise the agent's persisted config, otherwise the
   *      latest existing backup — a restore point ALWAYS exists before we
   *      destroy compute, so sleep never loses recoverable state.
   *   2. Stop + drop the container (the provider `stop` removes it from the
   *      node).
   *   3. Clear the compute identity (`sandbox_id`, `node_id`, `container_name`,
   *      ports, bridge/health URLs) so the slot is freed; the node autoscaler
   *      reclaims a now-empty Hetzner box on its next pass. The shared DB,
   *      `environment_vars`, and `docker_image` are retained for wake.
   *   4. Flip status to `sleeping`. No compute cost accrues while sleeping.
   *
   * The inverse is `executeWake`.
   */
  async executeSleep(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerRemoved: boolean;
    backupId?: string;
    error?: string;
  }> {
    // Primary read: replica lag must not turn a real sleep into a no-op.
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec || this.isAwaitingDeletion(rec.status))
      return { success: false, containerRemoved: false, error: "Agent not found" };
    if (rec.status === "sleeping") return { success: true, containerRemoved: true };
    if (rec.status === "provisioning") {
      return {
        success: false,
        containerRemoved: false,
        error: "Agent provisioning is in progress",
      };
    }

    // 1. Durable backup before compute is freed.
    let backupId: string | undefined;
    if (rec.status === "running" && rec.bridge_url) {
      try {
        const { stateData, sizeBytes } = await this.fetchSnapshotState(rec);
        const backup = await agentSandboxesRepository.createBackup({
          sandbox_record_id: rec.id,
          snapshot_type: "pre-shutdown",
          state_data: stateData,
          size_bytes: sizeBytes,
        });
        backupId = backup.id;
      } catch (error) {
        logger.warn("[agent-sandbox] Sleep snapshot fetch failed; using fallback", {
          agentId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (!backupId) {
      const existing = await agentSandboxesRepository.getLatestBackup(rec.id);
      if (existing) {
        backupId = existing.id;
      } else {
        const fallback: AgentBackupStateData = {
          memories: [],
          config: (rec.agent_config as Record<string, unknown> | null) ?? {},
          workspaceFiles: {},
        };
        const sizeBytes = Buffer.byteLength(JSON.stringify(fallback), "utf-8");
        const backup = await agentSandboxesRepository.createBackup(
          await this.buildBackupInput(rec.id, "pre-shutdown", fallback, sizeBytes),
        );
        backupId = backup.id;
      }
    }

    // 2. Tear down compute.
    let containerRemoved = false;
    if (rec.sandbox_id) {
      try {
        await (await this.getProvider()).stop(rec.sandbox_id);
        containerRemoved = true;
      } catch (e) {
        if (this.isIgnorableSandboxStopError(e)) {
          containerRemoved = true;
          logger.info("[agent-sandbox] Sandbox already absent during sleep", {
            sandboxId: rec.sandbox_id,
            error: e instanceof Error ? e.message : String(e),
          });
        } else {
          return {
            success: false,
            containerRemoved: false,
            error: e instanceof Error ? e.message : String(e),
          };
        }
      }
    } else {
      containerRemoved = true;
    }

    // 3. Free the slot; retain DB + env + image for wake.
    await agentSandboxesRepository.update(rec.id, {
      status: "sleeping",
      sandbox_id: null,
      bridge_url: null,
      health_url: null,
      node_id: null,
      container_name: null,
      bridge_port: null,
      web_ui_port: null,
      last_backup_at: new Date(),
    });
    await agentSandboxesRepository.pruneBackups(rec.id, MAX_BACKUPS).catch((error) => {
      logger.warn("[agent-sandbox] Backup pruning failed after sleep", {
        agentId,
        error: error instanceof Error ? error.message : String(error),
      });
    });

    logger.info("[agent-sandbox] Sleep complete", { agentId, backupId, containerRemoved });
    return { success: true, containerRemoved, backupId };
  }

  /**
   * Daemon-side handler for the `agent_wake` job — the inverse of sleep.
   *
   * Provisions a fresh container (claiming a warm-pool slot when available)
   * and relies on `provision()`'s built-in latest-backup restoration to
   * rehydrate the agent's state. Idempotent: waking an already-running agent
   * is a no-op.
   */
  async executeWake(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    reprovisioned: boolean;
    restoredBackupId?: string;
    error?: string;
  }> {
    // Primary read: a replica-lagged "Agent not found" must not no-op a wake.
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec || this.isAwaitingDeletion(rec.status))
      return { success: false, reprovisioned: false, error: "Agent not found" };
    if (rec.status === "running" && rec.bridge_url) {
      return { success: true, reprovisioned: false };
    }

    const latest = await agentSandboxesRepository.getLatestBackup(rec.id);
    const provisionResult = await this.provision(agentId, orgId);
    if (!provisionResult.success) {
      return { success: false, reprovisioned: true, error: provisionResult.error };
    }

    logger.info("[agent-sandbox] Wake complete", {
      agentId,
      restoredBackupId: latest?.id,
    });
    return { success: true, reprovisioned: true, restoredBackupId: latest?.id };
  }

  /**
   * Daemon-side handler for the `agent_restart` job. Runs `shutdown()`
   * (SSH stop + DB to stopped) and then `provision()` (recreate
   * container + restore URLs). Replaces the Worker-side sequence which
   * silently no-op'd the SSH stop and left the old container running
   * alongside the new one.
   *
   * `shutdown()` failure is logged but doesn't abort — same lenience as
   * the legacy restart route (the old container may already be gone or
   * unreachable; the goal is "end up with a running fresh container",
   * not "verify the old one stopped cleanly").
   */
  async executeRestart(
    agentId: string,
    orgId: string,
  ): Promise<{
    success: boolean;
    containerStopped: boolean;
    containerStarted: boolean;
    bridgeUrl?: string;
    healthUrl?: string;
    error?: string;
  }> {
    // Bail before shutdown()+provision() if the row is being deleted — restart
    // would otherwise flip a deletion_pending row to `stopped` and rebuild a
    // container the agent_delete job is tearing down. Reported as not-found so
    // the daemon handler completes the job as a terminal no-op. Read from the
    // PRIMARY so a replica-lagged status doesn't bail a legitimate restart (or
    // miss an in-flight deletion) on stale data.
    const rec = await this.getAgentForWrite(agentId, orgId);
    if (!rec || this.isAwaitingDeletion(rec.status)) {
      return {
        success: false,
        containerStopped: false,
        containerStarted: false,
        error: "Agent not found",
      };
    }

    const shutdownResult = await this.shutdown(agentId, orgId);
    if (!shutdownResult.success) {
      if (shutdownResult.error === "Agent not found") {
        return {
          success: false,
          containerStopped: false,
          containerStarted: false,
          error: "Agent not found",
        };
      }
      logger.warn("[agent-sandbox] Shutdown during restart returned error, continuing", {
        agentId,
        error: shutdownResult.error,
      });
    }

    const provisionResult = await this.provision(agentId, orgId);
    if (!provisionResult.success) {
      return {
        success: false,
        containerStopped: shutdownResult.success,
        containerStarted: false,
        error: provisionResult.error,
      };
    }

    return {
      success: true,
      containerStopped: shutdownResult.success,
      containerStarted: true,
      bridgeUrl: provisionResult.bridgeUrl,
      healthUrl: provisionResult.healthUrl,
    };
  }

  /**
   * Daemon-side handler for the `agent_upgrade` job: blue/green swap an
   * agent onto the currently-deployed image.
   *
   * Flow:
   *   1. Snapshot the agent's current node + container info.
   *   2. Provision a fresh container (blue) on a *different* node — the
   *      provider's container name is deterministic (`agent-${id}`), so the
   *      blue must land on a different docker daemon. The provider's
   *      `excludeNodeId` makes this guarantee.
   *   3. Health-check blue, then gate on its `/api/health` runtime readiness:
   *      ready runtime, DB ok, and zero failed plugins. Plugin/database
   *      migrations run during blue startup, so this is the migration verify
   *      gate before any traffic cutover.
   *   4. Capture a pre-upgrade snapshot from the still-live old container.
   *   5. Atomic UPDATE: swap the row's bridge_url / node_id / container_name
   *      / image_digest. New HTTP requests hit blue from this point on.
   *   6. Best-effort SIGTERM (30s drain) on the old container, then remove
   *      it. Already-in-flight HTTP responses on the old finish; websockets
   *      get a clean drop and reconnect to blue.
   */
  async executeUpgrade(
    agentId: string,
    orgId: string,
    toDigest: string,
    dockerImage: string,
    fromDigest: string | null,
  ): Promise<{
    success: boolean;
    oldNodeId?: string;
    oldContainerName?: string;
    newNodeId?: string;
    newContainerName?: string;
    newDigest?: string | null;
    error?: string;
    /**
     * True when this failure is ROLLBACK-SAFE: the OLD container was never torn
     * down (or was confirmed alive) and is still serving traffic, so the upgrade
     * failed WITHOUT taking the agent down. The permanent-failure writeback must
     * NOT mark such a sandbox terminal — doing so makes the dedicated proxy
     * reject live traffic (dedicated-agent-proxy.ts) and exposes the still-live
     * container to the orphan reconciler (docker-node-workloads.ts). Undefined
     * on success. `false` means the agent is genuinely not serving on the old
     * container (e.g. it was already not running), so the terminal error
     * writeback is correct.
     *
     * INVARIANT: every `success:false` path in executeUpgrade below returns
     * before the atomic swap commits, so the OLD container is untouched — the
     * blue/health/digest/runtime/snapshot/swap-failure paths all tear down ONLY
     * the freshly-provisioned blue and leave old alive. The only genuinely-dead
     * outcome is `Agent not running` (old already not serving); `Agent not
     * found` is intercepted upstream by completeIfAgentGone and never reaches
     * the writeback. See #15357 / lalalune's #15311 review.
     */
    rolledBack?: boolean;
  }> {
    const agent = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!agent) return { success: false, error: "Agent not found" };
    if (agent.status !== "running") {
      // Genuinely-dead: the old container is not serving (status is not
      // running), so the terminal error writeback is correct here.
      return {
        success: false,
        rolledBack: false,
        error: `Agent not running (status: ${agent.status})`,
      };
    }
    if (!agent.node_id || !agent.container_name) {
      // Shared-runtime / web-only row: nothing was torn down. The old serving
      // path is untouched. (These are already excluded by the reconciler.)
      return {
        success: false,
        rolledBack: true,
        error: "Agent has no node_id or container_name to upgrade from",
      };
    }
    // Refuse a fleet upgrade only for a genuinely CUSTOM image (a different
    // repo than the fleet-managed default), NOT for a stale default-family
    // image pinned to an older tag. Comparing the full ref (`docker_image !==
    // dockerImage`) refused every agent on an older `ghcr.io/elizaos/eliza:sha-*`
    // tag, so sha-pinned default agents never received fleet upgrades (#15101).
    // The reconciler already selects them by digest drift; the blue/green swap
    // re-provisions on the target image+digest, so moving a fleet-managed agent
    // to the current default is safe regardless of its current tag.
    if (agent.docker_image && imageRepo(agent.docker_image) !== imageRepo(dockerImage)) {
      // Refusal before any container work: old container is untouched and live.
      return {
        success: false,
        rolledBack: true,
        error: "Agent uses a custom docker image; refusing fleet upgrade",
      };
    }

    const oldNodeId = agent.node_id;
    const oldContainerName = agent.container_name;
    const oldSandboxId = agent.sandbox_id;
    const oldNode = await dockerNodesRepository.findByNodeId(oldNodeId);
    if (!oldNode) {
      // We could not resolve the old node to do a blue provision, but we did NOT
      // touch the old container — it is still running wherever it was. Treat as
      // rollback-safe: the agent keeps serving on the old container.
      return {
        success: false,
        rolledBack: true,
        error: `Old node ${oldNodeId} not registered in docker_nodes`,
      };
    }

    const provider = await this.getProvider();
    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    if (!(provider instanceof DockerSandboxProvider)) {
      // No container work happened; old container is untouched and live.
      return {
        success: false,
        rolledBack: true,
        error: "Fleet upgrade only supported on docker provider",
      };
    }

    // Materialize at-rest-encrypted BYO secrets before container create (#11332).
    const upgradeEnv = await decryptAgentEnvVars(
      (agent.environment_vars as Record<string, string>) ?? {},
    );
    const config = {
      agentId,
      agentName: agent.agent_name ?? "",
      organizationId: orgId,
      // Re-apply the cloud-managed inference defaults on top of the stored env so
      // an agent provisioned BEFORE the embedding-dimension / model pins landed
      // heals on upgrade instead of freezing a stale config (e.g. 1536-d cloud
      // vectors written into a dim_384 column → dropped memory + ~30s/turn). This
      // backfills ONLY the 5 inference keys if missing and preserves everything
      // else verbatim (DATABASE_URL, ELIZA_API_TOKEN, ELIZAOS_CLOUD_API_KEY,
      // ELIZA_AGENT_LOCAL_STATE, PGLITE_DATA_DIR, ELIZA_PLUGIN_SET, ...) — the
      // narrow helper deliberately avoids the full provision merge, which would
      // mint a new API key / strip DATABASE_URL / flip local-state on upgrade (#8434).
      environmentVars: {
        ...upgradeEnv,
        ...applyManagedAgentInferenceEnvDefaults(upgradeEnv),
      },
      dockerImage: digestPinnedImageRef(dockerImage, toDigest),
      excludeNodeId: oldNodeId,
    };

    let blueHandle: Awaited<ReturnType<typeof provider.create>>;
    try {
      blueHandle = await provider.create(config);
    } catch (err) {
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error: `Blue provision failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!(await provider.checkHealth(blueHandle))) {
      // Blue never came up. Roll back: tear it down, leave the agent on old.
      try {
        await provider.stop(blueHandle.sandboxId);
      } catch (err) {
        logger.warn("[agent-sandbox] Failed to tear down unhealthy blue during upgrade rollback", {
          agentId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error: "Blue health check failed; rolled back to old container",
      };
    }

    const blueMeta = isDockerSandboxMetadata(blueHandle.metadata) ? blueHandle.metadata : undefined;
    if (!blueMeta) {
      try {
        await provider.stop(blueHandle.sandboxId);
      } catch (err) {
        logger.warn(
          "[agent-sandbox] Failed to tear down blue with non-docker metadata during upgrade rollback",
          {
            agentId,
            err: err instanceof Error ? err.message : String(err),
          },
        );
      }
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error: "Blue provisioner returned non-docker metadata",
      };
    }
    if (blueMeta.imageDigest && blueMeta.imageDigest !== toDigest) {
      await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
        logger.warn("[agent-sandbox] Failed to tear down blue after digest mismatch", {
          agentId,
          err: stopErr instanceof Error ? stopErr.message : String(stopErr),
        }),
      );
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error: `Blue image digest mismatch: expected ${toDigest}, got ${blueMeta.imageDigest}`,
      };
    }

    const runtimeHealth = await this.verifyUpgradeRuntimeHealth({
      agent,
      bridgeUrl: blueHandle.bridgeUrl,
    });
    if (!runtimeHealth.success) {
      await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
        logger.warn("[agent-sandbox] Failed to tear down blue after runtime readiness failure", {
          agentId,
          err: stopErr instanceof Error ? stopErr.message : String(stopErr),
        }),
      );
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error: `Blue runtime readiness gate failed: ${runtimeHealth.error}`,
      };
    }

    // Capture a restore point on the OLD (still-live) container before the
    // cutover. This is the snapshot `executeDowngrade` replays when rolling
    // back. A missing/partial snapshot blocks the upgrade: swapping images
    // without a verified full-agent restore point is the data-loss class this
    // path is designed to prevent.
    const preUpgradeSnapshot = await this.snapshot(agentId, orgId, "pre-upgrade").catch((err) => ({
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }));
    if (!preUpgradeSnapshot.success) {
      await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
        logger.warn("[agent-sandbox] Failed to tear down blue after pre-upgrade snapshot failure", {
          agentId,
          err: stopErr instanceof Error ? stopErr.message : String(stopErr),
        }),
      );
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error: `Pre-upgrade snapshot failed: ${preUpgradeSnapshot.error ?? "unknown error"}`,
      };
    }

    try {
      const swapped = await dbWrite.transaction(async (tx) => {
        await this.lockLifecycle(tx, agentId, orgId);
        const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!current) return false;
        if (
          current.status !== "running" ||
          current.node_id !== oldNodeId ||
          current.container_name !== oldContainerName ||
          current.sandbox_id !== oldSandboxId ||
          current.image_digest !== fromDigest ||
          // The docker_image leg of this CAS exists to catch one concurrent
          // COMPETING change: the agent being repointed at a custom image (a
          // DIFFERENT repo) while the blue provisioned — adopting the blue
          // would clobber that user choice. It must NOT demand textual ref
          // equality: selection admits any tag/digest/empty pin of the fleet
          // repo (#15101 repo-match), so an exact-string compare abandoned
          // every selected sha-pinned or empty-pinned row AFTER the full blue
          // provision + snapshot, exhausted the job's retries, and the
          // exhaustion marker then froze the agent out of all future upgrades
          // (#15358). Mirror the selection/pre-provision semantics — abandon
          // only on a real repo change; the digest/node/container/sandbox legs
          // above still detect every other concurrent mutation.
          (current.docker_image && imageRepo(current.docker_image) !== imageRepo(dockerImage))
        ) {
          return false;
        }
        const result = await tx.execute<{ id: string }>(sql`
          UPDATE ${agentSandboxes}
          SET
            sandbox_id = ${blueHandle.sandboxId},
            bridge_url = ${blueHandle.bridgeUrl},
            health_url = ${blueHandle.healthUrl},
            node_id = ${blueMeta.nodeId},
            container_name = ${blueMeta.containerName},
            bridge_port = ${blueMeta.bridgePort},
            web_ui_port = ${blueMeta.webUiPort},
            headscale_ip = ${blueMeta.headscaleIp ?? null},
            image_digest = ${toDigest},
            previous_image_digest = ${fromDigest},
            previous_docker_image = ${current.docker_image || dockerImage},
            error_message = NULL,
            last_heartbeat_at = NOW(),
            updated_at = NOW()
          WHERE id = ${agentId}
            AND organization_id = ${orgId}
            AND status = 'running'
          RETURNING id
        `);
        return result.rows.length === 1;
      });
      if (!swapped) {
        throw new Error("Agent changed during upgrade; abandoned stale swap");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error("[agent-sandbox] Atomic swap UPDATE failed; tearing down orphaned blue", {
        agentId,
        err: errMsg,
      });
      await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
        logger.warn("[agent-sandbox] Failed to tear down blue after atomic swap UPDATE failure", {
          agentId,
          err: stopErr instanceof Error ? stopErr.message : String(stopErr),
        }),
      );
      return {
        success: false,
        rolledBack: true,
        oldNodeId,
        oldContainerName,
        error: `Atomic swap UPDATE failed: ${errMsg}`,
      };
    }

    // Old container teardown is best-effort: traffic is already on blue.
    await provider.stopOnSpecificNode(oldNode, oldContainerName, 30);

    logger.info("[agent-sandbox] Fleet upgrade completed", {
      agentId,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
      requestedDigest: toDigest,
    });

    return {
      success: true,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
    };
  }

  /**
   * Operator-gated rollback of the most recent fleet upgrade. Symmetric to
   * `executeUpgrade`: a blue/green swap back onto `previous_image_digest`, the
   * digest captured at the last upgrade's swap.
   *
   * Flow:
   *   1. Resolve the rollback target from `previous_image_digest` /
   *      `previous_docker_image`. If there is none, there is nothing to roll
   *      back to — bail without touching the live agent.
   *   2. Provision a fresh container (blue) on the prior image, on a different
   *      node, and health-check it (same guarantees as upgrade).
   *   3. Restore the `pre-upgrade` snapshot onto blue BEFORE cutover so the
   *      rolled-back agent comes up with the state it had before the upgrade.
   *      The bridge push is guarded and mandatory: an image without
   *      `/api/restore` fails the rollback before traffic moves.
   *   4. Atomic CAS swap: point the row at blue, set `image_digest` to the
   *      prior digest, and clear the previous-image columns (the upgrade we
   *      just undid is no longer the rollback target).
   *   5. Best-effort teardown of the old (post-upgrade) container.
   *
   * This is invoked only behind an explicit operator action — it never runs
   * automatically (image-rollout-status reports `rollback` as a gated,
   * operator-approved action, not an automatic one).
   */
  async executeDowngrade(
    agentId: string,
    orgId: string,
    dockerImage: string,
    fromDigest: string,
  ): Promise<{
    success: boolean;
    oldNodeId?: string;
    oldContainerName?: string;
    newNodeId?: string;
    newContainerName?: string;
    newDigest?: string | null;
    error?: string;
  }> {
    const agent = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!agent) return { success: false, error: "Agent not found" };
    if (agent.status !== "running") {
      return {
        success: false,
        error: `Agent not running (status: ${agent.status})`,
      };
    }
    if (!agent.node_id || !agent.container_name) {
      return {
        success: false,
        error: "Agent has no node_id or container_name to roll back from",
      };
    }
    // Same fleet-managed-vs-custom distinction as the upgrade path (#15101):
    // a rollback of a default-family agent must not be refused just because its
    // tag differs from the target.
    if (agent.docker_image && imageRepo(agent.docker_image) !== imageRepo(dockerImage)) {
      return {
        success: false,
        error: "Agent uses a custom docker image; refusing fleet rollback",
      };
    }
    const toDigest = agent.previous_image_digest;
    if (!toDigest) {
      return {
        success: false,
        error: "No previous image digest persisted; nothing to roll back to",
      };
    }
    if (agent.image_digest !== fromDigest) {
      return {
        success: false,
        error: `Agent is not on the expected post-upgrade digest (expected ${fromDigest}, found ${agent.image_digest})`,
      };
    }

    const oldNodeId = agent.node_id;
    const oldContainerName = agent.container_name;
    const oldSandboxId = agent.sandbox_id;
    const oldNode = await dockerNodesRepository.findByNodeId(oldNodeId);
    if (!oldNode) {
      return {
        success: false,
        error: `Old node ${oldNodeId} not registered in docker_nodes`,
      };
    }

    const provider = await this.getProvider();
    const { DockerSandboxProvider } = await import("./docker-sandbox-provider");
    if (!(provider instanceof DockerSandboxProvider)) {
      return {
        success: false,
        error: "Fleet rollback only supported on docker provider",
      };
    }

    const rollbackImage = agent.previous_docker_image || dockerImage;
    // Materialize at-rest-encrypted BYO secrets before container create (#11332).
    const rollbackEnv = await decryptAgentEnvVars(
      (agent.environment_vars as Record<string, string>) ?? {},
    );
    const config = {
      agentId,
      agentName: agent.agent_name ?? "",
      organizationId: orgId,
      environmentVars: {
        ...rollbackEnv,
        ...applyManagedAgentInferenceEnvDefaults(rollbackEnv),
      },
      dockerImage: digestPinnedImageRef(rollbackImage, toDigest),
      excludeNodeId: oldNodeId,
    };

    let blueHandle: Awaited<ReturnType<typeof provider.create>>;
    try {
      blueHandle = await provider.create(config);
    } catch (err) {
      return {
        success: false,
        oldNodeId,
        oldContainerName,
        error: `Blue provision failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    if (!(await provider.checkHealth(blueHandle))) {
      await provider.stop(blueHandle.sandboxId).catch((err) =>
        logger.warn("[agent-sandbox] Failed to tear down unhealthy blue during rollback", {
          agentId,
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      return {
        success: false,
        oldNodeId,
        oldContainerName,
        error: "Blue health check failed; kept agent on current image",
      };
    }

    const blueMeta = isDockerSandboxMetadata(blueHandle.metadata) ? blueHandle.metadata : undefined;
    if (!blueMeta) {
      await provider.stop(blueHandle.sandboxId).catch((err) =>
        logger.warn(
          "[agent-sandbox] Failed to tear down blue with non-docker metadata in rollback",
          {
            agentId,
            err: err instanceof Error ? err.message : String(err),
          },
        ),
      );
      return {
        success: false,
        oldNodeId,
        oldContainerName,
        error: "Blue provisioner returned non-docker metadata",
      };
    }
    if (blueMeta.imageDigest && blueMeta.imageDigest !== toDigest) {
      await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
        logger.warn("[agent-sandbox] Failed to tear down blue after rollback digest mismatch", {
          agentId,
          err: stopErr instanceof Error ? stopErr.message : String(stopErr),
        }),
      );
      return {
        success: false,
        oldNodeId,
        oldContainerName,
        error: `Blue image digest mismatch: expected ${toDigest}, got ${blueMeta.imageDigest}`,
      };
    }

    // Restore the pre-upgrade state onto blue BEFORE cutover. A rollback that
    // cannot replay the verified restore point is not a rollback, so fail
    // loudly and leave the current image serving traffic.
    const preUpgradeBackup = await agentSandboxesRepository.getLatestBackupByType(
      agent.id,
      "pre-upgrade",
    );
    if (preUpgradeBackup) {
      const restoreState = await agentSandboxesRepository.getReconstructedBackupState(
        preUpgradeBackup.id,
      );
      if (restoreState) {
        try {
          await this.pushState(blueHandle.bridgeUrl, restoreState, {
            trusted: true,
            authRec: agent,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
            logger.warn("[agent-sandbox] Failed to tear down blue after rollback restore failure", {
              agentId,
              err: stopErr instanceof Error ? stopErr.message : String(stopErr),
            }),
          );
          return {
            success: false,
            oldNodeId,
            oldContainerName,
            error: `Pre-upgrade state restore failed: ${message}`,
          };
        }
      } else {
        await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
          logger.warn("[agent-sandbox] Failed to tear down blue after empty rollback restore", {
            agentId,
            err: stopErr instanceof Error ? stopErr.message : String(stopErr),
          }),
        );
        return {
          success: false,
          oldNodeId,
          oldContainerName,
          error: `Pre-upgrade backup ${preUpgradeBackup.id} could not be reconstructed`,
        };
      }
    } else {
      await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
        logger.warn("[agent-sandbox] Failed to tear down blue after missing rollback snapshot", {
          agentId,
          err: stopErr instanceof Error ? stopErr.message : String(stopErr),
        }),
      );
      return {
        success: false,
        oldNodeId,
        oldContainerName,
        error: "No pre-upgrade snapshot found; refusing rollback without restore point",
      };
    }

    try {
      const swapped = await dbWrite.transaction(async (tx) => {
        await this.lockLifecycle(tx, agentId, orgId);
        const current = await this.getAgentForLifecycleMutation(tx, agentId, orgId);
        if (!current) return false;
        if (
          current.status !== "running" ||
          current.node_id !== oldNodeId ||
          current.container_name !== oldContainerName ||
          current.sandbox_id !== oldSandboxId ||
          current.image_digest !== fromDigest ||
          // Same repo-match semantics as the upgrade swap's CAS above: this
          // leg detects a concurrent repoint at a DIFFERENT repo, not textual
          // pin drift within the fleet repo (an empty or tag/digest-pinned
          // docker_image on the same repo is still the fleet image — #15101,
          // #15358). `dockerImage` here is the recorded rollback ref.
          (current.docker_image && imageRepo(current.docker_image) !== imageRepo(dockerImage))
        ) {
          return false;
        }
        const result = await tx.execute<{ id: string }>(sql`
          UPDATE ${agentSandboxes}
          SET
            sandbox_id = ${blueHandle.sandboxId},
            bridge_url = ${blueHandle.bridgeUrl},
            health_url = ${blueHandle.healthUrl},
            node_id = ${blueMeta.nodeId},
            container_name = ${blueMeta.containerName},
            bridge_port = ${blueMeta.bridgePort},
            web_ui_port = ${blueMeta.webUiPort},
            headscale_ip = ${blueMeta.headscaleIp ?? null},
            image_digest = ${toDigest},
            previous_image_digest = NULL,
            previous_docker_image = NULL,
            last_heartbeat_at = NOW(),
            updated_at = NOW()
          WHERE id = ${agentId}
            AND organization_id = ${orgId}
            AND status = 'running'
          RETURNING id
        `);
        return result.rows.length === 1;
      });
      if (!swapped) {
        throw new Error("Agent changed during rollback; abandoned stale swap");
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error(
        "[agent-sandbox] Rollback atomic swap UPDATE failed; tearing down orphaned blue",
        {
          agentId,
          err: errMsg,
        },
      );
      await provider.stop(blueHandle.sandboxId).catch((stopErr) =>
        logger.warn("[agent-sandbox] Failed to tear down blue after rollback swap UPDATE failure", {
          agentId,
          err: stopErr instanceof Error ? stopErr.message : String(stopErr),
        }),
      );
      return {
        success: false,
        oldNodeId,
        oldContainerName,
        error: `Rollback atomic swap UPDATE failed: ${errMsg}`,
      };
    }

    // Old (post-upgrade) container teardown is best-effort: traffic is on blue.
    await provider.stopOnSpecificNode(oldNode, oldContainerName, 30);

    logger.info("[agent-sandbox] Fleet rollback completed", {
      agentId,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
    });

    return {
      success: true,
      oldNodeId,
      oldContainerName,
      newNodeId: blueMeta.nodeId,
      newContainerName: blueMeta.containerName,
      newDigest: toDigest,
    };
  }

  /**
   * Daemon-side handler for the `agent_logs` job. SSH `docker logs
   * --tail N <container>` on the assigned core via the provider. The
   * daemon path works for stopped/crashed agents (the legacy Worker
   * path hits the bridge HTTP `/logs` endpoint which is gone when the
   * agent isn't running).
   */
  async executeLogs(
    agentId: string,
    orgId: string,
    tail: number,
  ): Promise<{
    success: boolean;
    status: string;
    logs?: string;
    message?: string;
    error?: string;
  }> {
    const rec = await agentSandboxesRepository.findByIdAndOrg(agentId, orgId);
    if (!rec) {
      return { success: false, status: "missing", error: "Agent not found" };
    }
    if (!rec.sandbox_id) {
      return {
        success: true,
        status: rec.status,
        message: `Agent is ${rec.status} — no container assigned yet.`,
      };
    }

    const provider = await this.getProvider();
    if (typeof provider.fetchLogs !== "function") {
      return {
        success: true,
        status: rec.status,
        message: "Logs unavailable: sandbox provider does not implement fetchLogs.",
      };
    }

    try {
      const logs = await provider.fetchLogs(rec.sandbox_id, tail);
      return { success: true, status: rec.status, logs };
    } catch (e) {
      return {
        success: false,
        status: rec.status,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  }

  /**
   * Daemon-side handler for the `agent_snapshot` job. Same operation
   * as the Worker-side `snapshot()` path, but invoked from the daemon
   * so outbound traffic to the agent bridge uses the same network
   * identity as every other cores-bound call. Returns the
   * `agent_sandbox_backups` row that was persisted.
   */
  async executeSnapshot(
    agentId: string,
    orgId: string,
    snapshotType: "manual" | "auto" = "manual",
  ): Promise<SnapshotResult> {
    return await this.snapshot(agentId, orgId, snapshotType);
  }

  // Private helpers

  private async lockLifecycle(tx: LifecycleTx, agentId: string, orgId: string): Promise<void> {
    await tx.execute(elizaProvisionAdvisoryLockSql(orgId, agentId));
  }

  private async getAgentForLifecycleMutation(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<AgentSandbox | undefined> {
    const result = await tx.execute<AgentSandbox>(sql`
      SELECT *
      FROM ${agentSandboxes}
      WHERE id = ${agentId}
        AND organization_id = ${orgId}
      FOR UPDATE
    `);
    return result.rows[0];
  }

  private async hasActiveProvisionJobTx(
    tx: LifecycleTx,
    agentId: string,
    orgId: string,
  ): Promise<boolean> {
    const result = await tx.execute<{ id: string }>(sql`
      SELECT id
      FROM ${jobs}
      WHERE type = ${JOB_TYPES.AGENT_PROVISION}
        AND organization_id = ${orgId}
        AND ${jobs.agent_id} = ${agentId}
        AND status IN ('pending', 'in_progress')
      LIMIT 1
    `);
    return result.rows.length > 0;
  }

  private async fetchSnapshotState(
    rec: Pick<
      AgentSandbox,
      | "id"
      | "bridge_url"
      | "health_url"
      | "node_id"
      | "bridge_port"
      | "web_ui_port"
      | "headscale_ip"
      | "sandbox_id"
      | "environment_vars"
    >,
  ): Promise<{
    stateData: AgentBackupStateData;
    sizeBytes: number;
    bridgeUrl: string;
  }> {
    if (!rec.bridge_url) {
      throw new Error("Sandbox is not running");
    }

    const snapshotEndpoint = await this.getAgentApiEndpoint(rec, "/api/snapshot");
    const res = await fetch(snapshotEndpoint, {
      method: "POST",
      headers: this.getAgentJsonHeaders(rec),
      signal: AbortSignal.timeout(SNAPSHOT_FETCH_TIMEOUT_MS),
    });
    if (res.status === 404) {
      // The deployed agent image does not expose POST /api/snapshot (only the
      // cloud-agent template image does). Surface a recognizable sentinel so an
      // auto snapshot is skipped, not hard-failed-and-retried.
      throw new Error(SNAPSHOT_ENDPOINT_UNSUPPORTED);
    }
    if (!res.ok) {
      throw new Error(`Snapshot fetch failed: HTTP ${res.status}`);
    }

    const stateData = (await res.json()) as AgentBackupStateData;
    const sizeBytes = Buffer.byteLength(JSON.stringify(stateData), "utf-8");

    return {
      stateData,
      sizeBytes,
      bridgeUrl: rec.bridge_url,
    };
  }

  private async persistSnapshotWithinTransaction(
    tx: LifecycleTx,
    sandboxRecordId: string,
    organizationId: string,
    type: AgentBackupSnapshotType,
    stateData: AgentBackupStateData,
    sizeBytes: number,
  ): Promise<void> {
    const [backup] = await tx
      .insert(agentSandboxBackups)
      .values(
        await prepareAgentBackupInsertData(
          {
            sandbox_record_id: sandboxRecordId,
            snapshot_type: type,
            state_data: stateData,
            size_bytes: sizeBytes,
          },
          organizationId,
        ),
      )
      .returning();

    await tx.execute(sql`
      UPDATE ${agentSandboxes}
      SET
        last_backup_at = NOW(),
        updated_at = NOW()
      WHERE id = ${sandboxRecordId}
    `);

    logger.info("[agent-sandbox] Backup created", {
      agentId: sandboxRecordId,
      type,
      bytes: backup?.size_bytes ?? sizeBytes,
    });
  }

  /**
   * The single degrade path for a snapshot `isUnrecoverableSnapshotError`
   * cannot restore on THIS provision (#15210): log it loudly, then boot fresh
   * instead of bricking the agent. Never throws — the caller continues to a
   * fresh boot, which must not be derailed by cleanup.
   *
   * Pruning the backup chain is gated on `isPermanentlyLostSnapshot` (#15274):
   * only drop it when the snapshot can NEVER be restored (crypto corruption /
   * gone-key, or HTTP 404/410). For a RECOVERABLE auth failure (401/403) we
   * still boot fresh but PRESERVE the chain, so a later token-corrected resume
   * (#15263) can restore it — pruning a recoverable snapshot on a transient 401
   * is silent, permanent data loss (`pruneBackups(agentId, 0)` deletes the
   * whole chain and there is no undo).
   */
  private async degradeUnrecoverableSnapshot(
    agentId: string,
    backupId: string | undefined,
    error: unknown,
  ): Promise<void> {
    const permanentlyLost = isPermanentlyLostSnapshot(error);
    logger.error("[agent-sandbox] Unrecoverable snapshot, booting fresh", {
      agentId,
      backupId,
      permanentlyLost,
      // A recoverable auth failure keeps the chain for the next authenticated
      // resume; a permanent loss drops it so the next resume boots clean.
      backupChain: permanentlyLost ? "pruned" : "preserved",
      error: error instanceof Error ? error.message : String(error),
    });
    // Preserve the chain on a recoverable failure (auth 401/403): a
    // token-corrected resume can still restore it, so pruning here would be
    // silent, permanent data loss (#15274).
    if (!permanentlyLost) return;
    // error-policy:J6 best-effort — a failed prune only means we warn + degrade
    // again next boot, never that we fail to boot fresh, so it must not throw
    // out of the provision.
    await agentSandboxesRepository.pruneBackups(agentId, 0).catch((pruneErr) => {
      logger.warn("[agent-sandbox] Failed to drop orphaned snapshot after degrade", {
        agentId,
        error: pruneErr instanceof Error ? pruneErr.message : String(pruneErr),
      });
    });
  }

  private async markError(rec: AgentSandbox, msg: string) {
    await agentSandboxesRepository.update(rec.id, {
      status: "error",
      error_message: msg,
      error_count: (rec.error_count ?? 0) + 1,
    });
  }

  /**
   * Resume a prior transport-unresolved provision attempt before creating a new
   * deterministic Docker container. The provider's container name is
   * `agent-${id}`; calling create again while the preserved container still
   * exists turns Docker's "already in use" into a cleanup path that removes the
   * very container the retry was meant to save.
   */
  private buildProvisioningRetryHandle(rec: AgentSandbox): SandboxHandle | null {
    if (!rec.sandbox_id || !rec.bridge_url || !rec.health_url) return null;
    const hasDockerFleetColumns = Boolean(
      rec.node_id || rec.container_name || rec.bridge_port || rec.web_ui_port,
    );
    return {
      sandboxId: rec.sandbox_id,
      bridgeUrl: rec.bridge_url,
      healthUrl: rec.health_url,
      metadata: hasDockerFleetColumns
        ? {
            provider: "docker",
            nodeId: rec.node_id ?? "",
            hostname: rec.node_id ?? "",
            containerName: rec.container_name ?? "",
            bridgePort: rec.bridge_port ?? undefined,
            webUiPort: rec.web_ui_port ?? undefined,
            headscaleIp: rec.headscale_ip ?? undefined,
          }
        : rec.headscale_ip
          ? { headscaleIp: rec.headscale_ip }
          : undefined,
    };
  }

  /**
   * Persist a freshly-created container's handle onto the sandbox row while
   * KEEPING `status: "provisioning"`. Used when the post-create readiness probe
   * came back `transport_unresolved` (the probe never reached the container, so
   * it is likely healthy): writing `sandbox_id` + ingress/metadata columns is
   * what lets the daemon stuck-provisioning reconciler FIND the row (it filters
   * on `sandbox_id IS NOT NULL`) and re-probe it, and what lets a provision-job
   * retry adopt the existing container instead of colliding on its
   * deterministic name. Deliberately does NOT flip to `running` — only a
   * confirmed-healthy re-probe may do that. Best-effort: a write failure here is
   * logged, not thrown (the retryable error is surfaced regardless).
   */
  private async persistContainerHandleForRetry(
    agentId: string,
    handle: SandboxHandle,
    dockerMeta: DockerSandboxMetadata | undefined,
  ): Promise<void> {
    if (isDockerBackedMetadata(handle.metadata) && !dockerMeta?.nodeId) {
      logger.error(
        "[agent-sandbox] Refusing to persist retry handle: docker-backed handle has no durable node_id",
        {
          agentId,
          sandboxId: handle.sandboxId,
          hasDockerMeta: Boolean(dockerMeta),
        },
      );
      throw new Error(
        `${PROVISION_ATTRIBUTION_GUARD_PREFIX} docker-backed sandbox ${handle.sandboxId} produced no durable node_id during transport-unresolved retry; refusing to preserve an unattributable container handle`,
      );
    }

    try {
      const updateData: Parameters<typeof agentSandboxesRepository.update>[1] = {
        sandbox_id: handle.sandboxId,
        bridge_url: handle.bridgeUrl,
        health_url: handle.healthUrl,
      };
      if (dockerMeta) {
        if (dockerMeta.nodeId) updateData.node_id = dockerMeta.nodeId;
        if (dockerMeta.containerName) updateData.container_name = dockerMeta.containerName;
        if (dockerMeta.bridgePort) updateData.bridge_port = dockerMeta.bridgePort;
        if (dockerMeta.webUiPort) updateData.web_ui_port = dockerMeta.webUiPort;
        if (dockerMeta.headscaleIp) updateData.headscale_ip = dockerMeta.headscaleIp;
        if (dockerMeta.dockerImage) updateData.docker_image = dockerMeta.dockerImage;
        updateData.image_digest = dockerMeta.imageDigest;
      }
      await agentSandboxesRepository.update(agentId, updateData);
    } catch (error) {
      logger.warn(
        "[agent-sandbox] Failed to persist container handle for transport-unresolved retry",
        { agentId, error: error instanceof Error ? error.message : String(error) },
      );
    }
  }

  private async provisionAgentDatabase(
    rec: AgentSandbox,
  ): Promise<{ success: boolean; connectionUri?: string; error?: string }> {
    // Use the shared Railway cloud database instead of per-agent databases.
    // ElizaOS plugin-sql tables scope all data by agent UUID, so multiple agents
    // safely coexist in one database.
    const sharedDbUrl = process.env.DATABASE_URL;
    if (!sharedDbUrl) {
      return {
        success: false,
        error: "DATABASE_URL not configured in cloud environment",
      };
    }

    await agentSandboxesRepository.update(rec.id, {
      database_uri: sharedDbUrl,
      database_status: "ready",
      database_error: null,
    });

    return { success: true, connectionUri: sharedDbUrl };
  }

  private isIgnorableSandboxStopError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error);
    const normalized = message.toLowerCase();
    return (
      normalized.includes("not found") ||
      normalized.includes("already gone") ||
      normalized.includes("no longer exists") ||
      normalized.includes("404")
    );
  }

  private async pushState(
    sandboxOrBridgeUrl:
      | Pick<
          AgentSandbox,
          | "id"
          | "bridge_url"
          | "health_url"
          | "node_id"
          | "bridge_port"
          | "web_ui_port"
          | "headscale_ip"
          | "sandbox_id"
          | "environment_vars"
        >
      | string,
    state: AgentBackupStateData,
    options?: {
      trusted?: boolean;
      // Bridge-URL callers pass a bare string, so `pushState` cannot derive the
      // agent's ELIZA_API_TOKEN from it and the trusted branch used to send no
      // auth header. That worked while `/api/restore` exempted trusted-bridge
      // requests, but the cloud agent image now requires the token even over the
      // tailnet (server-helpers-auth `isCloudProvisionedContainer()` disables the
      // local-trust exemption) — so an unauthenticated restore deterministically
      // 401s (#15261). Pass the sandbox record here to attach the token.
      authRec?: Pick<AgentSandbox, "id" | "environment_vars">;
    },
  ) {
    const restoreEndpoint =
      typeof sandboxOrBridgeUrl === "string"
        ? await this.getSafeBridgeEndpoint(sandboxOrBridgeUrl, "/api/restore", options)
        : await this.getAgentApiEndpoint(sandboxOrBridgeUrl, "/api/restore");
    const res = await fetch(restoreEndpoint, {
      method: "POST",
      headers:
        typeof sandboxOrBridgeUrl === "string"
          ? options?.authRec
            ? this.getAgentJsonHeaders(options.authRec)
            : { "Content-Type": "application/json" }
          : this.getAgentJsonHeaders(sandboxOrBridgeUrl),
      body: JSON.stringify(state),
      signal: AbortSignal.timeout(SNAPSHOT_RESTORE_TIMEOUT_MS),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`State restore failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
  }
}

export const elizaSandboxService = new ElizaSandboxService();
