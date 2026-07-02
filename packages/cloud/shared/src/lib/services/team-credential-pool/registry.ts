/**
 * Per-org AccountPool registry (#11332).
 *
 * The self-host AccountPool assumes ONE pool per process (wired through
 * globalThis bridges). Cloud is multi-tenant: this registry holds one
 * `AccountPool` + `DrizzleAccountPoolDeps` per organization in an LRU-evicted
 * map, and NEVER touches the globalThis bridges (those are single-tenant
 * self-host plumbing).
 *
 * The AccountPool class is loaded lazily from @elizaos/app-core/account-pool
 * and every public method is strict-fallback: any failure (module load, DB,
 * decrypt) returns null / no-ops so callers keep today's platform-env
 * behavior. Pooled keys are an additive layer, never a new failure mode.
 *
 * Keep-alive: a low-frequency sweep over ACTIVE orgs (orgs currently in the
 * registry) that (a) re-probes flagged credentials whose cool-off has passed
 * and heals them, and (b) re-probes healthy credentials that haven't been
 * verified recently, flagging revoked keys needs-reauth — the only way the
 * containers-first path can learn a pooled key died (containers call the
 * provider directly; cloud never sees their 401s). It arms lazily on first
 * pool creation and is a no-op wherever long-lived timers aren't available
 * (Cloudflare Workers) — there `filterEligible` still re-admits expired
 * rate-limits at selection time and every acquire refreshes from the DB.
 */

import type { AccountPool, Strategy } from "@elizaos/app-core/account-pool";
import { pooledCredentialsRepository } from "../../../db/repositories/pooled-credentials";
import { logger } from "../../utils/logger";
import { secretsService } from "../secrets/secrets";
import { DrizzleAccountPoolDeps } from "./pool-deps";
import { probePooledApiKey } from "./probe";
import {
  isPooledDirectProvider,
  POOLED_PROVIDER_ENV_KEYS,
  type PooledDirectProvider,
} from "./provider-map";

const DEFAULT_MAX_ORG_POOLS = 200;
const SNAPSHOT_TTL_MS = 15_000;
const KEEP_ALIVE_INTERVAL_MS = 5 * 60_000;
const KEEP_ALIVE_PROBES_PER_SWEEP = 8;
/** Healthy credentials get re-verified when older than this. */
const STALE_OK_REPROBE_MS = 6 * 60 * 60_000;

interface OrgPoolEntry {
  pool: AccountPool;
  deps: DrizzleAccountPoolDeps;
  lastAccessAt: number;
}

export interface SelectPooledCredentialParams {
  organizationId: string;
  providerId: PooledDirectProvider;
  /** Stable affinity key (e.g. agent sandbox id). */
  sessionKey?: string;
  strategy?: Strategy;
}

export interface SelectedPooledCredential {
  credentialId: string;
  providerId: PooledDirectProvider;
  envKey: string;
  apiKey: string;
  label: string;
}

export class TeamPoolRegistry {
  private readonly pools = new Map<string, OrgPoolEntry>();
  private readonly maxOrgPools: number;
  private keepAlive: ReturnType<typeof setInterval> | null = null;

  constructor(options?: { maxOrgPools?: number }) {
    this.maxOrgPools = options?.maxOrgPools ?? DEFAULT_MAX_ORG_POOLS;
  }

  /** Orgs with a live pool instance (keep-alive scope). */
  activeOrgIds(): string[] {
    return [...this.pools.keys()];
  }

  /** Drop an org's cached pool so the next acquire re-reads the DB. */
  invalidate(organizationId: string): void {
    this.pools.delete(organizationId);
  }

  /**
   * Acquire (and lazily create) the org's pool with a fresh-enough snapshot.
   * Returns null on ANY failure — strict fallback, callers keep current
   * behavior.
   */
  async getOrgPool(organizationId: string): Promise<OrgPoolEntry | null> {
    try {
      let entry = this.pools.get(organizationId);
      if (!entry) {
        const { AccountPool: AccountPoolClass } = await import("@elizaos/app-core/account-pool");
        const deps = new DrizzleAccountPoolDeps(organizationId);
        entry = {
          pool: new AccountPoolClass(deps),
          deps,
          lastAccessAt: Date.now(),
        };
        this.pools.set(organizationId, entry);
        this.evictLru();
        this.armKeepAlive();
      }
      if (entry.deps.isStale(SNAPSHOT_TTL_MS)) {
        await entry.deps.refresh();
      }
      entry.lastAccessAt = Date.now();
      // LRU recency = Map insertion order.
      this.pools.delete(organizationId);
      this.pools.set(organizationId, entry);
      return entry;
    } catch (err) {
      logger.warn("[TeamPoolRegistry] pool acquire failed — falling back to platform env", {
        organizationId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Select a credential for `providerId` and resolve its raw key from the
   * secrets vault. Null when the org has no eligible pooled credential.
   */
  async selectCredential(
    params: SelectPooledCredentialParams,
  ): Promise<SelectedPooledCredential | null> {
    const entry = await this.getOrgPool(params.organizationId);
    if (!entry) return null;
    try {
      const account = await entry.pool.select({
        providerId: params.providerId,
        ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
        strategy: params.strategy ?? "round-robin",
      });
      if (!account) return null;
      const secretId = entry.deps.secretIdFor(account.id);
      if (!secretId) return null;
      const apiKey = await secretsService.getDecryptedValue(secretId, params.organizationId, {
        actorType: "system",
        actorId: "team-credential-pool",
        source: "team-credential-pool",
      });
      return {
        credentialId: account.id,
        providerId: params.providerId,
        envKey: POOLED_PROVIDER_ENV_KEYS[params.providerId],
        apiKey,
        label: account.label,
      };
    } catch (err) {
      logger.warn("[TeamPoolRegistry] credential selection failed — falling back", {
        organizationId: params.organizationId,
        providerId: params.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * Attribute one call to (credential, member, UTC day) and bump the pool's
   * last-used stamp. Replaces the self-host JSONL usage log.
   */
  async recordUse(params: {
    organizationId: string;
    credentialId: string;
    userId: string;
  }): Promise<void> {
    try {
      const day = new Date().toISOString().slice(0, 10);
      await pooledCredentialsRepository.recordDailyUsage({
        organizationId: params.organizationId,
        credentialId: params.credentialId,
        userId: params.userId,
        day,
      });
      await pooledCredentialsRepository.updatePoolStateForOrganization(
        params.credentialId,
        params.organizationId,
        {
          last_used_at: new Date(),
        },
      );
    } catch (err) {
      logger.warn("[TeamPoolRegistry] usage attribution failed", {
        organizationId: params.organizationId,
        credentialId: params.credentialId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Feed direct Worker/provider failures back into the org pool. Only statuses
   * that tell us something about the selected credential mutate pool health:
   * auth failures need reauth, and 429s cool off the credential briefly.
   */
  async recordProviderFailure(params: {
    organizationId: string;
    credentialId: string;
    providerId: PooledDirectProvider;
    status: number;
    detail?: string;
  }): Promise<void> {
    if (![401, 403, 429].includes(params.status)) return;
    try {
      const entry = await this.getOrgPool(params.organizationId);
      if (!entry) return;
      const detail = params.detail ?? `provider returned ${params.status}`;
      if (params.status === 429) {
        await entry.pool.markRateLimited(params.credentialId, Date.now() + 60_000, detail, {
          providerId: params.providerId,
        });
      } else {
        await entry.pool.markNeedsReauth(params.credentialId, detail, {
          providerId: params.providerId,
        });
      }
    } catch (err) {
      logger.warn("[TeamPoolRegistry] provider failure writeback failed", {
        organizationId: params.organizationId,
        credentialId: params.credentialId,
        providerId: params.providerId,
        status: params.status,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private evictLru(): void {
    while (this.pools.size > this.maxOrgPools) {
      const oldest = this.pools.keys().next().value;
      if (oldest === undefined) break;
      this.pools.delete(oldest);
    }
  }

  private armKeepAlive(): void {
    if (this.keepAlive) return;
    try {
      this.keepAlive = setInterval(() => {
        void this.sweepActivePools();
      }, KEEP_ALIVE_INTERVAL_MS);
      // Never keep a node process alive just for the sweep.
      if (typeof this.keepAlive === "object" && "unref" in this.keepAlive) {
        this.keepAlive.unref();
      }
    } catch {
      // Global timers are unavailable in some runtimes (Cloudflare Workers) —
      // selection-time re-admission + per-acquire refresh cover healing there.
      this.keepAlive = null;
    }
  }

  /**
   * One keep-alive pass over ACTIVE orgs: refresh snapshots, then re-probe
   * (bounded per sweep) first the flagged credentials whose cool-off has
   * passed, then healthy credentials not verified within
   * {@link STALE_OK_REPROBE_MS}. A passing probe heals the credential and
   * stamps `healthDetail.lastChecked`; a 401/403 marks needs-reauth — how a
   * key revoked at the provider console leaves rotation. Other failures
   * (network, 5xx, 429) leave state untouched: never flag on a transient.
   */
  async sweepActivePools(): Promise<void> {
    let probes = 0;
    for (const [organizationId, entry] of this.pools) {
      try {
        await entry.deps.refresh();
        const flagged = await entry.pool.reprobeFlagged();
        const staleCutoff = Date.now() - STALE_OK_REPROBE_MS;
        const staleOk = entry.pool
          .list()
          .filter(
            (account) =>
              account.health === "ok" &&
              !flagged.includes(account.id) &&
              (account.healthDetail?.lastChecked ?? 0) < staleCutoff,
          )
          .map((account) => account.id);
        for (const credentialId of [...flagged, ...staleOk]) {
          if (probes >= KEEP_ALIVE_PROBES_PER_SWEEP) return;
          const account = entry.pool.get(credentialId);
          if (!account || !isPooledDirectProvider(account.providerId)) continue;
          const secretId = entry.deps.secretIdFor(credentialId);
          if (!secretId) continue;
          probes += 1;
          const apiKey = await secretsService.getDecryptedValue(secretId, organizationId, {
            actorType: "system",
            actorId: "team-credential-pool",
            source: "team-credential-pool-keep-alive",
          });
          const result = await probePooledApiKey(account.providerId, apiKey);
          if (result.ok) {
            await entry.deps.writeAccount({
              ...account,
              health: "ok",
              healthDetail: { lastChecked: Date.now() },
            });
          } else if (result.status === 401 || result.status === 403) {
            await entry.pool.markNeedsReauth(credentialId, result.error, {
              providerId: account.providerId,
            });
          }
        }
      } catch (err) {
        logger.warn("[TeamPoolRegistry] keep-alive sweep failed for org", {
          organizationId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}

let registry: TeamPoolRegistry | null = null;

/** Process-wide registry accessor (NOT a cross-tenant globalThis bridge). */
export function getTeamPoolRegistry(): TeamPoolRegistry {
  if (!registry) registry = new TeamPoolRegistry();
  return registry;
}
