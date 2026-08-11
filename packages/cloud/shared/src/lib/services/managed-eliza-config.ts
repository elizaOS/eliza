// Coordinates cloud service managed eliza config behavior behind route handlers.
import crypto from "node:crypto";
import { EXTERNAL_URLS } from "@elizaos/shared/brand";
import type { DbTransaction } from "../../db/client";
import { getElizaAgentPublicWebUiUrl } from "../eliza-agent-web-ui";
import { CEREBRAS_DEFAULT_TEXT_LARGE_MODEL, CEREBRAS_DEFAULT_TEXT_SMALL_MODEL } from "../models";
import { getCloudAwareEnv } from "../runtime/cloud-bindings";
import { apiKeysService } from "./api-keys";
import { findReservedEnvKeys, RESERVED_PLATFORM_ENV_KEYS } from "./reserved-env-keys";

const DEFAULT_ELIZA_APP_URL = EXTERNAL_URLS.app;
const DEFAULT_CLOUD_PUBLIC_URL = "https://www.elizacloud.ai";
const DEV_ELIZA_APP_ORIGINS = [
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://localhost:4173",
  "http://127.0.0.1:4173",
] as const;
/**
 * Platform-reserved env keys for the managed agent path. Aliases the shared
 * {@link RESERVED_PLATFORM_ENV_KEYS} denylist - single source of truth, also
 * enforced on the Apps deploy path - and stays a named export for existing
 * importers (the agent environment route).
 */
export const RESERVED_MANAGED_ELIZA_ENV_KEYS = RESERVED_PLATFORM_ENV_KEYS;

export interface ManagedElizaEnvironmentResult {
  apiToken: string;
  changed: boolean;
  environmentVars: Record<string, string>;
  agentApiKey: string;
  /**
   * Hashes of the sandbox keys this preparation revoked. A caller that
   * prepared inside its own transaction MUST re-invalidate them after COMMIT
   * (`apiKeysService.confirmRevocationAfterCommit`) — the pre-commit pass ran
   * while the old rows were still visible to other connections.
   */
  revokedKeyHashes: string[];
}

export interface ManagedElizaBaseEnvironmentResult {
  apiToken: string;
  environmentVars: Record<string, string>;
  agentApiKey: string;
  revokedKeyHashes: string[];
}

export interface PrepareManagedElizaSharedEnvironmentParams {
  existingEnv?: Record<string, string> | null;
  organizationId: string;
  userId: string;
  agentSandboxId: string;
  /**
   * The caller's open primary transaction, when it has one. Preparation mints
   * the agent's cloud key, so a caller inside a transaction must pass it or
   * that mint checks out a second pooled connection while holding the first.
   * Callers that prepare unlocked (cold provision, tier upgrade) leave it unset.
   */
  tx?: DbTransaction;
}

export function findReservedManagedElizaEnvKeys(keys: Iterable<string>): string[] {
  return findReservedEnvKeys(keys);
}

export function normalizeBaseUrl(raw: string): string {
  return raw.trim().replace(/\/+$/, "");
}

export function resolveElizaAppUrl(): string {
  const env = getCloudAwareEnv();
  return normalizeBaseUrl(
    env.NEXT_PUBLIC_ELIZA_APP_URL || env.ELIZA_APP_URL || DEFAULT_ELIZA_APP_URL,
  );
}

export function resolveCloudPublicUrl(): string {
  const env = getCloudAwareEnv();
  return normalizeBaseUrl(
    env.NEXT_PUBLIC_APP_URL || env.ELIZA_CLOUD_URL || DEFAULT_CLOUD_PUBLIC_URL,
  );
}

export function resolveCloudApiBaseUrl(): string {
  const env = getCloudAwareEnv();
  const explicit =
    env.ELIZAOS_CLOUD_BASE_URL || env.ELIZA_CLOUD_API_BASE_URL || env.NEXT_PUBLIC_API_URL;
  if (explicit) {
    return normalizeBaseUrl(explicit);
  }
  return `${resolveCloudPublicUrl()}/api/v1`;
}

function parseOrigin(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

export function resolveManagedAllowedOrigins(): string[] {
  const origins = new Set<string>();
  const appOrigin = parseOrigin(resolveElizaAppUrl());
  const cloudOrigin = parseOrigin(resolveCloudPublicUrl());
  if (appOrigin) origins.add(appOrigin);
  if (cloudOrigin) origins.add(cloudOrigin);

  const env = getCloudAwareEnv();
  if (env.NODE_ENV !== "production") {
    for (const origin of DEV_ELIZA_APP_ORIGINS) {
      origins.add(origin);
    }
  }

  const extraOrigins = env.ELIZA_MANAGED_ALLOWED_ORIGINS;
  if (extraOrigins) {
    for (const item of extraOrigins.split(",")) {
      const trimmed = item.trim();
      if (!trimmed) continue;
      const normalized = parseOrigin(trimmed);
      if (normalized) origins.add(normalized);
    }
  }

  return [...origins];
}

export function mergeManagedAllowedOrigins(existingValue?: string): string {
  const merged = new Set<string>();
  if (existingValue) {
    for (const entry of existingValue.split(",")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const origin = parseOrigin(trimmed);
      if (origin) merged.add(origin);
    }
  }

  for (const origin of resolveManagedAllowedOrigins()) {
    merged.add(origin);
  }

  return [...merged].join(",");
}

function isManagedPublicBaseUrlCandidate(value: string): boolean {
  const trimmed = value.trim();
  if (
    trimmed.includes("(new-agent-id)") ||
    trimmed.includes("<agent-id>") ||
    trimmed.includes("${agentId}")
  ) {
    return true;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return true;
  }

  const hostname = url.hostname.toLowerCase();
  return (
    url.protocol !== "https:" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".trycloudflare.com") ||
    hostname.endsWith(".ngrok-free.app") ||
    hostname.endsWith(".ngrok.io")
  );
}

export function mergeManagedPublicBaseUrl(
  existingValue: string | undefined,
  agentSandboxId: string,
): string {
  const publicUrl = getElizaAgentPublicWebUiUrl({
    id: agentSandboxId,
    headscale_ip: null,
  });
  const trimmed = existingValue?.trim();

  if (!publicUrl) {
    return trimmed ?? "";
  }

  if (!trimmed || isManagedPublicBaseUrlCandidate(trimmed)) {
    return publicUrl;
  }

  return trimmed;
}

/**
 * The cloud-managed inference defaults: the embedding endpoint + the cloud
 * embedding handler's OUTPUT dimensions, and the Cerebras-direct small/large
 * model pins. Pure and single-source-of-truth - both the provision path (via
 * prepareManagedElizaBaseEnvironment) and the blue/green fleet-upgrade path
 * (eliza-sandbox.ts) backfill these onto an agent's stored env so an agent
 * provisioned BEFORE these pins landed heals on upgrade (#8434). An explicit
 * per-agent value always wins.
 *
 * Local-primary restore: when a managed lean-chat agent opts in with
 * ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS=1, keep cloud text generation defaults but
 * stop pinning the cloud embedding handler as primary. The local gte-small
 * handler emits 384-d vectors, so the managed defaults also move the embedding
 * dimension hints to 384 for that agent. This is deliberately per-agent and
 * flag-gated: existing 1536-d stores must be re-embedded/backfilled before the
 * flag is enabled or recall can degrade (#9911 class).
 *
 * NOTE on dimensions: EMBEDDING_DIMENSION / ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS
 * set the width of the vectors the plugin-elizacloud TEXT_EMBEDDING handler
 * EMITS when cloud embeddings are enabled (1536 by default, 384 for the
 * local-primary opt-in so all probes/storage hints agree). They do NOT size the
 * plugin-sql storage column - plugin-sql never reads either var. The storage
 * column width is decided at boot by runtime.ensureEmbeddingDimension(), which
 * probes the registered embedding handler's actual vector length and snaps the
 * column to that dimension. That probe must run before bundled docs are seeded;
 * that boot ordering was the real no-memory bug (#8769) - fixed in
 * packages/agent/src/runtime/eliza.ts, not here.
 */
export function applyManagedAgentInferenceEnvDefaults(
  existingEnv: Record<string, string>,
): Record<string, string> {
  const localPrimaryEmbeddings =
    existingEnv.ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS === "1" &&
    existingEnv.ELIZAOS_CLOUD_USE_EMBEDDINGS?.trim().toLowerCase() !== "true";
  const embeddingDimension = localPrimaryEmbeddings ? "384" : "1536";
  return {
    ...(localPrimaryEmbeddings ? { ELIZAOS_CLOUD_USE_EMBEDDINGS: "false" } : {}),
    ELIZAOS_CLOUD_EMBEDDING_URL:
      existingEnv.ELIZAOS_CLOUD_EMBEDDING_URL ?? resolveCloudApiBaseUrl(),
    EMBEDDING_DIMENSION: existingEnv.EMBEDDING_DIMENSION ?? embeddingDimension,
    ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS:
      existingEnv.ELIZAOS_CLOUD_EMBEDDING_DIMENSIONS ?? embeddingDimension,
    ELIZAOS_CLOUD_SMALL_MODEL:
      existingEnv.ELIZAOS_CLOUD_SMALL_MODEL ?? CEREBRAS_DEFAULT_TEXT_SMALL_MODEL,
    ELIZAOS_CLOUD_LARGE_MODEL:
      existingEnv.ELIZAOS_CLOUD_LARGE_MODEL ?? CEREBRAS_DEFAULT_TEXT_LARGE_MODEL,
  };
}

export async function prepareManagedElizaBaseEnvironment(
  params: PrepareManagedElizaSharedEnvironmentParams,
): Promise<ManagedElizaBaseEnvironmentResult> {
  const existingEnv = { ...(params.existingEnv ?? {}) };
  // DATABASE_URL / ELIZA_MANAGED_DATABASE_URL are managed reserved keys
  // (RESERVED_MANAGED_ELIZA_ENV_KEYS); the sandbox layer
  // (computeManagedAgentDbEnv in eliza-sandbox.ts) is the SOLE authority on the
  // agent's DB env. Strip any inherited value here so the control-plane's OWN
  // DATABASE_URL - which the cloud Worker / provisioning daemon carries in its
  // process env and which spreads in through params.existingEnv - cannot leak
  // into the agent and silently override ELIZA_AGENT_LOCAL_STATE=1. That leak
  // forced every "local-state" agent onto the remote shared Railway Postgres
  // (~166ms/query x dozens of serial reads+writes per turn = the dominant
  // dedicated-chat latency, plus the shared-DB blast radius). With these
  // removed, a local-state agent gets only PGlite (+ ELIZA_MANAGED_DATABASE_URL
  // opt-in), while a shared-DB agent (ELIZA_AGENT_LOCAL_STATE=0) still has
  // DATABASE_URL re-injected by computeManagedAgentDbEnv.
  delete existingEnv.DATABASE_URL;
  delete existingEnv.ELIZA_MANAGED_DATABASE_URL;
  const { plainKey: agentApiKey, revokedKeyHashes } = await apiKeysService.createForAgent({
    organizationId: params.organizationId,
    userId: params.userId,
    agentSandboxId: params.agentSandboxId,
    tx: params.tx,
  });
  const apiToken =
    existingEnv.ELIZA_API_TOKEN?.trim() || `agent_${crypto.randomUUID().replace(/-/g, "")}`;

  return {
    apiToken,
    agentApiKey,
    revokedKeyHashes,
    environmentVars: {
      ...existingEnv,
      // Hosting-mode marker: this process is a managed Eliza Cloud agent, not a
      // user-owned/self-hosted install. Always forced on for the managed path —
      // callers cannot clear or override it (also in RESERVED_PLATFORM_ENV_KEYS).
      // The agent server exposes it as `cloudProvisioned` on /api/status and
      // /api/first-run/status so the UI can render managed vs user-owned UX.
      ELIZA_CLOUD_PROVISIONED: "1",
      ELIZA_API_TOKEN: apiToken,
      ELIZA_ALLOW_WS_QUERY_TOKEN: "1",
      ELIZA_ALLOWED_ORIGINS: mergeManagedAllowedOrigins(existingEnv.ELIZA_ALLOWED_ORIGINS),
      // Public web UI on by default - users access it via the agent
      // subdomain (https://<agent-id>.elizacloud.ai), gated by
      // ELIZA_API_TOKEN at the agent-router. Set ELIZA_UI_ENABLE=false in
      // existingEnv to opt out per-agent.
      ELIZA_UI_ENABLE: existingEnv.ELIZA_UI_ENABLE ?? "true",
      ELIZAOS_CLOUD_API_KEY: agentApiKey,
      ELIZAOS_CLOUD_ENABLED: "true",
      ELIZAOS_CLOUD_BASE_URL: resolveCloudApiBaseUrl(),
      // Cloud-managed inference defaults: by default pin embeddings to the
      // elizacloud Worker base (whose POST /embeddings serves 1536-dim
      // text-embedding-3-small - without it the plugin falls back to the
      // Cerebras/BitRouter text base with no /embeddings route -> 503), pin
      // BOTH embedding-output dimensions to the handler's output width, and pin
      // the healthy Cerebras-direct small/large models so the container never
      // resolves a tier to the `:nitro` default. For the explicit
      // ELIZA_LEAN_CHAT_LOCAL_EMBEDDINGS=1 rollout lane, the helper yields the
      // cloud embedding slot and uses 384-dim hints so local gte-small,
      // ensureEmbeddingDimension, and storage agree. Each value still honors an
      // explicit per-agent override in existingEnv.
      ...applyManagedAgentInferenceEnvDefaults(existingEnv),
      // New managed agents keep agent-state in a LOCAL in-container DB (PGlite on
      // the persistent /root/.eliza volume) instead of the shared cloud Postgres;
      // auth + discovery still flow through the cloud API (ELIZAOS_CLOUD_* above).
      // This removes the shared-Postgres connection hot path that caused the
      // "too many clients" incident (#8696). The flag is read at container-create
      // time (eliza-sandbox.ts): only agents PROVISIONED with it set go local, so
      // existing agents keep their shared-DB state untouched - a forward cutover
      // with no migration. Set ELIZA_AGENT_LOCAL_STATE=0 to provision a new agent
      // on the shared DB instead. PGLITE_DATA_DIR is pinned under the persistent
      // mount so local state survives container restarts.
      ELIZA_AGENT_LOCAL_STATE: existingEnv.ELIZA_AGENT_LOCAL_STATE ?? "1",
      PGLITE_DATA_DIR: existingEnv.PGLITE_DATA_DIR ?? "/root/.eliza/.pgdata",
      // New dedicated agents boot the lean chat plugin set (no shell/coding-tools/
      // browser/orchestrator) for fast cold-start (#8434). Override per agent by
      // pinning ELIZA_PLUGIN_SET to another value at create.
      ELIZA_PLUGIN_SET: existingEnv.ELIZA_PLUGIN_SET ?? "lean-chat",
      // Lean Postgres pool - only applies to agents still on the SHARED DB
      // (existing agents, or new agents provisioned with ELIZA_AGENT_LOCAL_STATE=0).
      // The default per-agent pool (max 20 / min 2) exhausts the server's
      // max_connections at scale (50 idle agents × min 2 = 100). Cap bursts at 8
      // and let idle agents release ALL connections (min 0). plugin-sql reads
      // POSTGRES_POOL_*; harmless (unused) under local PGlite.
      POSTGRES_POOL_MAX: existingEnv.POSTGRES_POOL_MAX ?? "8",
      POSTGRES_POOL_MIN: existingEnv.POSTGRES_POOL_MIN ?? "0",
      POSTGRES_POOL_IDLE_TIMEOUT_MS: existingEnv.POSTGRES_POOL_IDLE_TIMEOUT_MS ?? "15000",
      ELIZA_CLOUD_AGENT_ID: params.agentSandboxId,
      PUBLIC_BASE_URL: mergeManagedPublicBaseUrl(
        existingEnv.PUBLIC_BASE_URL,
        params.agentSandboxId,
      ),
      WAIFU_ELIZA_CLOUD_AGENT_ID: params.agentSandboxId,
    },
  };
}

export async function prepareManagedElizaSharedEnvironment(
  params: PrepareManagedElizaSharedEnvironmentParams,
): Promise<ManagedElizaEnvironmentResult> {
  const existingEnv = { ...(params.existingEnv ?? {}) };
  const baseEnvironment = await prepareManagedElizaBaseEnvironment({
    existingEnv,
    organizationId: params.organizationId,
    userId: params.userId,
    agentSandboxId: params.agentSandboxId,
    tx: params.tx,
  });
  const environmentVars: Record<string, string> = {
    ...baseEnvironment.environmentVars,
  };

  return {
    apiToken: environmentVars.ELIZA_API_TOKEN,
    changed: JSON.stringify(existingEnv) !== JSON.stringify(environmentVars),
    environmentVars,
    agentApiKey: baseEnvironment.agentApiKey,
    revokedKeyHashes: baseEnvironment.revokedKeyHashes,
  };
}
