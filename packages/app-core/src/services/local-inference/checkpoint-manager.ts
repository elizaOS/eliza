/**
 * Feature-flagged + capability-detected wrapper around the REST-backed
 * `CheckpointManager` from `voice/checkpoint-manager.ts`.
 *
 * Why two layers?
 *
 *   - `voice/checkpoint-manager.ts` is the production primitive: REST adapter
 *     + handle bookkeeping + mock implementation. It is referenced directly
 *     by `voice/voice-state-machine.ts` and by `voice/prefill-client.ts`,
 *     both of which expect callers to have already decided whether the
 *     feature is on.
 *
 *   - This module is the *runtime gate*. It owns:
 *       1. The process-wide feature flag (`ELIZA_CTX_CHECKPOINTS=1` env, or
 *          `useCtxCheckpoints` constructor option — env wins when set).
 *       2. Capability detection against a running llama-server (`/health`
 *          probe via the underlying `CheckpointClient`).
 *       3. A no-op fallback path so callers — the `checkpoint-policy.ts`
 *          module in particular — can write unconditional `save / restore /
 *          erase / cancel` calls without branching on the flag.
 *       4. A named-handle registry with TTL eviction. The upstream server
 *          has its own LRU on `--ctx-checkpoints N`; this registry tracks
 *          *our* names → handles so the policy module can refer to
 *          `'pre-speculative-T123'` instead of opaque filenames.
 *
 *     When the upstream merge lands, flip `ELIZA_CTX_CHECKPOINTS=1` and the
 *     wrapper starts forwarding to the REST manager. Until then, every call
 *     short-circuits to a logged no-op.
 *
 * Feature-flag behavior matrix:
 *
 *   | flag | server-supports | save                  | restore               | erase   | cancel              |
 *   | OFF  | n/a             | no-op + warn          | no-op + warn          | no-op   | SSE-disconnect cb   |
 *   | ON   | NO  (probe=fail)| no-op + warn          | no-op + warn          | no-op   | SSE-disconnect cb   |
 *   | ON   | YES (probe=ok)  | REST POST /slots/.../save | REST POST /slots/.../restore | n/a | DELETE /slots/<id>  |
 *
 * The "SSE-disconnect callback" is supplied by the caller (the voice loop
 * owns the SSE stream and the abort handle); when the flag/probe is off the
 * wrapper just invokes the callback synchronously.
 *
 * This module deliberately does NOT modify `turn-controller.ts`,
 * `pipeline.ts`, `pipeline-impls.ts`, `vad.ts`, `scheduler.ts`,
 * `phrase-chunker.ts`, `barge-in.ts`, `transcriber.ts`, or anything under
 * `voice/kokoro/` / `voice/streaming-asr/`. Those files are owned by other
 * agents; the policy in `voice/checkpoint-policy.ts` is the integration
 * point.
 */

import { logger } from "@elizaos/core";
import {
  CheckpointClient,
  type CheckpointFetch,
} from "./dflash-checkpoint-client";
import {
  type CheckpointHandle,
  type CheckpointManagerLike,
  CheckpointManager as RestCheckpointManager,
} from "./voice/checkpoint-manager";

export type {
  CheckpointHandle,
  CheckpointManagerLike,
} from "./voice/checkpoint-manager";

/**
 * Env-var name that flips the JS-side feature on. The matching server-side
 * `--ctx-checkpoints` flag is appended automatically by
 * `appendCtxCheckpointFlags` in `dflash-server.ts` when the catalog tier
 * declares `optimizations.ctxCheckpoints` AND the `--help` probe says the
 * binary supports the flag — those two gates are independent of this one.
 */
export const CTX_CHECKPOINTS_ENV_VAR = "ELIZA_CTX_CHECKPOINTS";

/**
 * Default TTL for entries in the named registry. The upstream server runs
 * its own LRU on `--ctx-checkpoints N` (default 8 per slot); this TTL is
 * for *our* name → handle mapping so a stale name doesn't keep a handle
 * pinned forever. 10 minutes covers any plausible mid-conversation pause
 * with margin; anything older than that the policy module should re-save
 * rather than reuse.
 */
export const DEFAULT_NAMED_HANDLE_TTL_MS = 10 * 60 * 1000;

/**
 * Read the process-wide feature flag. Truthy values: `1`, `true`, `yes`.
 * Anything else (including absent) is `false`. Matches `readBool` in
 * `dflash-server.ts`.
 */
export function readCtxCheckpointsEnvFlag(): boolean {
  const raw = process.env[CTX_CHECKPOINTS_ENV_VAR]?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

/**
 * Caller-supplied "abort the in-flight SSE stream for this slot" hook. The
 * voice loop owns the actual SSE handle (held by `turn-controller.ts` via
 * the speculative `AbortController`); the policy module hands a thunk in
 * here so `cancel(slotId)` works identically with the flag on or off.
 */
export type SseDisconnectFn = (slotId: number) => void;

export interface GatedCheckpointManagerOptions {
  /**
   * `http://host:port` base URL of the running llama-server. May be `null`
   * when the caller has not yet started the server — every method then
   * routes through the no-op path until `setBaseUrl` is called.
   */
  baseUrl: string | null;
  /**
   * Explicit override for the feature flag. When unset, the env var
   * (`ELIZA_CTX_CHECKPOINTS`) is consulted. When set, the env var is
   * ignored. Tests pass `false` to assert the no-op path; production code
   * leaves this `undefined` so the env var wins.
   */
  useCtxCheckpoints?: boolean;
  /**
   * Optional custom fetch (mostly for unit tests). Forwarded to
   * `CheckpointClient`.
   */
  fetchImpl?: CheckpointFetch;
  /** Per-request timeout for REST calls (ms). Default 1500ms. */
  requestTimeoutMs?: number;
  /**
   * Optional slot-id resolver. Forwarded to the underlying
   * `CheckpointManager`. Default is the 31-bit hash → `% 256` resolver
   * defined in `voice/checkpoint-manager.ts`.
   */
  resolveSlotId?: (slotIdString: string) => number;
  /**
   * TTL (ms) for entries in the named handle registry. Default 10 minutes.
   * Set to 0 to disable TTL eviction (entries live until explicitly
   * cleared).
   */
  namedHandleTtlMs?: number;
  /** Injected clock for tests. Defaults to `Date.now`. */
  now?: () => number;
}

interface NamedHandleEntry {
  handle: CheckpointHandle;
  /** Wall-clock ms at which this entry was registered. */
  registeredAtMs: number;
}

/**
 * Process-wide gate around the REST-backed `CheckpointManager`. Owns the
 * feature flag, capability detection cache, named-handle registry, and a
 * fallback path for `cancel` that calls back into the voice loop's SSE
 * disconnect when REST is not available.
 *
 * Stateless w.r.t. checkpoint data — handles live in the underlying
 * REST manager / on llama-server's `--slot-save-path` directory. Stateful
 * w.r.t. names: the registry maps human-readable names like
 * `'pre-speculative-T123'` to the underlying `CheckpointHandle`.
 */
export class GatedCheckpointManager {
  private readonly explicitFlag: boolean | undefined;
  private readonly fetchImpl?: CheckpointFetch;
  private readonly requestTimeoutMs?: number;
  private readonly resolveSlotId?: (slotIdString: string) => number;
  private readonly namedHandleTtlMs: number;
  private readonly now: () => number;
  private readonly named = new Map<string, NamedHandleEntry>();

  private baseUrl: string | null;
  /** Lazy: built on first use once `baseUrl` is non-null. */
  private restManager: RestCheckpointManager | null = null;
  /** Lazy: built on first capability probe. */
  private capabilityClient: CheckpointClient | null = null;
  /** Cached capability probe result. Cleared on `setBaseUrl`. */
  private serverSupportsCheckpoints: boolean | null = null;

  constructor(opts: GatedCheckpointManagerOptions) {
    this.baseUrl = opts.baseUrl;
    this.explicitFlag = opts.useCtxCheckpoints;
    if (opts.fetchImpl !== undefined) {
      this.fetchImpl = opts.fetchImpl;
    }
    if (opts.requestTimeoutMs !== undefined) {
      this.requestTimeoutMs = opts.requestTimeoutMs;
    }
    if (opts.resolveSlotId !== undefined) {
      this.resolveSlotId = opts.resolveSlotId;
    }
    this.namedHandleTtlMs =
      opts.namedHandleTtlMs ?? DEFAULT_NAMED_HANDLE_TTL_MS;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Whether the JS-side feature flag is on. Does NOT check capability —
   * call `detectCapability()` for the combined gate.
   */
  isFeatureFlagOn(): boolean {
    return this.explicitFlag !== undefined
      ? this.explicitFlag
      : readCtxCheckpointsEnvFlag();
  }

  /**
   * Combined gate: feature flag AND base URL set AND server probe (cached)
   * returned true. Callers that want the up-to-the-second view should call
   * `detectCapability(true)` to force a re-probe.
   */
  isEnabled(): boolean {
    return (
      this.isFeatureFlagOn() &&
      this.baseUrl !== null &&
      this.serverSupportsCheckpoints === true
    );
  }

  /**
   * Update the base URL after a server (re)start. Clears the capability
   * cache so the next `detectCapability()` re-probes.
   */
  setBaseUrl(baseUrl: string | null): void {
    if (this.baseUrl === baseUrl) return;
    this.baseUrl = baseUrl;
    this.restManager = null;
    this.capabilityClient = null;
    this.serverSupportsCheckpoints = null;
  }

  /**
   * Probe llama-server for checkpoint support. Caches the result; pass
   * `force=true` to re-probe (e.g. after the server reports a restart).
   * Returns `false` when the feature flag is off — the probe is short-
   * circuited because there's no point asking the server when the JS side
   * isn't going to call the endpoints anyway.
   */
  async detectCapability(force = false): Promise<boolean> {
    if (!this.isFeatureFlagOn()) {
      this.serverSupportsCheckpoints = false;
      return false;
    }
    if (this.baseUrl === null) {
      this.serverSupportsCheckpoints = false;
      return false;
    }
    if (!force && this.serverSupportsCheckpoints !== null) {
      return this.serverSupportsCheckpoints;
    }
    const client = this.getCapabilityClient();
    try {
      const supported = await client.probeSupported();
      this.serverSupportsCheckpoints = supported;
      if (!supported) {
        logger.warn(
          `[checkpoint-manager] llama-server at ${this.baseUrl} did not advertise ctx-checkpoint support; falling back to SSE-disconnect cancel and no-op save/restore. Verify the buun-llama-cpp build picked up the upstream --ctx-checkpoints merge.`,
        );
      }
      return supported;
    } catch (error) {
      logger.warn(
        { error },
        "[checkpoint-manager] capability probe failed; assuming unsupported",
      );
      this.serverSupportsCheckpoints = false;
      return false;
    }
  }

  /**
   * Snapshot the slot's KV state under `name`. Registers `name → handle`
   * in the registry so later `restore(slotId, name)` / `erase(slotId,
   * name)` calls can look the handle up. Replaces any prior entry with the
   * same name. No-op (returns `null`) when the gate is off.
   *
   * Naming convention: callers should encode the conversation/turn id
   * into the name so multiple slots don't collide
   * (`pre-speculative-T123`, not `pre-speculative`).
   */
  async save(slotId: number, name: string): Promise<CheckpointHandle | null> {
    this.evictExpired();
    if (!this.isEnabled()) {
      logger.debug(
        `[checkpoint-manager] save(${slotId}, ${name}) — no-op (feature flag off or server unsupported)`,
      );
      return null;
    }
    const manager = this.getRestManager();
    const handle = await manager.saveCheckpoint(restSlotIdString(slotId), name);
    this.named.set(name, { handle, registeredAtMs: this.now() });
    return handle;
  }

  /**
   * Restore the slot from a previously-saved snapshot. The `handle`
   * argument may be:
   *
   *   - A `CheckpointHandle` returned from a prior `save()` — pass it
   *     directly; the manager goes straight to the REST endpoint.
   *   - A string `name` — looked up in the registry. Returns `false` if
   *     the name is unknown or has expired; callers can fall back to
   *     re-running the speculative draft from scratch.
   *
   * Returns `true` on success, `false` on no-op / unknown handle. Never
   * throws for the "feature off" path; REST errors do propagate.
   */
  async restore(
    slotId: number,
    handleOrName: CheckpointHandle | string,
  ): Promise<boolean> {
    this.evictExpired();
    if (!this.isEnabled()) {
      logger.debug(
        `[checkpoint-manager] restore(${slotId}, ${typeof handleOrName === "string" ? handleOrName : handleOrName.name}) — no-op (feature flag off or server unsupported)`,
      );
      return false;
    }
    const handle = this.resolveHandle(handleOrName);
    if (!handle) {
      logger.debug(
        `[checkpoint-manager] restore(${slotId}, ${String(handleOrName)}) — handle not found in registry (expired or never saved)`,
      );
      return false;
    }
    const manager = this.getRestManager();
    await manager.restoreCheckpoint(handle);
    return true;
  }

  /**
   * Erase the named entry from the local registry AND ask the underlying
   * REST manager to discard the checkpoint. No-op when the gate is off or
   * the name is unknown. The upstream server has no per-file delete today
   * (see comments in `voice/checkpoint-manager.ts`), so `discard` actually
   * cancels in-flight decode on the slot — semantically "drop everything
   * speculative".
   */
  async erase(
    slotId: number,
    handleOrName: CheckpointHandle | string,
  ): Promise<void> {
    if (!this.isEnabled()) {
      if (typeof handleOrName === "string") {
        this.named.delete(handleOrName);
      }
      logger.debug(
        `[checkpoint-manager] erase(${slotId}, ${typeof handleOrName === "string" ? handleOrName : handleOrName.name}) — no-op (feature flag off or server unsupported)`,
      );
      return;
    }
    const handle = this.resolveHandle(handleOrName);
    if (!handle) return;
    if (typeof handleOrName === "string") this.named.delete(handleOrName);
    const manager = this.getRestManager();
    try {
      await manager.discardCheckpoint(handle);
    } catch (error) {
      logger.warn(
        { error, slotId, name: handle.name },
        "[checkpoint-manager] discard failed",
      );
    }
  }

  /**
   * Cancel any in-flight generation on `slotId`. When the gate is on this
   * is `DELETE /slots/<id>`; when off it falls back to the SSE-disconnect
   * callback the voice loop supplied (so the speculative draft is still
   * aborted, just via the existing path).
   */
  async cancel(slotId: number, sseDisconnect: SseDisconnectFn): Promise<void> {
    if (!this.isEnabled()) {
      sseDisconnect(slotId);
      return;
    }
    const manager = this.getRestManager();
    try {
      // Synthesize a handle scoped to the slot so the underlying manager's
      // `discardCheckpoint` performs the cancel-slot REST call. We can't
      // use `discardCheckpoint` directly with a registry entry here
      // because the caller may not have one — `cancel` is the bare
      // "abort whatever is running" primitive.
      const fakeHandle = await manager.saveCheckpoint(
        restSlotIdString(slotId),
        cancelSentinelName(slotId, this.now()),
      );
      await manager.discardCheckpoint(fakeHandle);
    } catch (error) {
      logger.warn(
        { error, slotId },
        "[checkpoint-manager] cancel via REST failed; falling back to SSE-disconnect",
      );
      sseDisconnect(slotId);
    }
  }

  /** Look up a previously-registered name. */
  getNamedHandle(name: string): CheckpointHandle | null {
    this.evictExpired();
    return this.named.get(name)?.handle ?? null;
  }

  /** Number of live entries in the named registry. */
  registrySize(): number {
    this.evictExpired();
    return this.named.size;
  }

  /** Clear the entire registry. Useful on conversation end / server restart. */
  clearRegistry(): void {
    this.named.clear();
  }

  // --- internals -------------------------------------------------------

  private resolveHandle(
    handleOrName: CheckpointHandle | string,
  ): CheckpointHandle | null {
    if (typeof handleOrName !== "string") return handleOrName;
    return this.named.get(handleOrName)?.handle ?? null;
  }

  private evictExpired(): void {
    if (this.namedHandleTtlMs <= 0) return;
    const cutoff = this.now() - this.namedHandleTtlMs;
    for (const [name, entry] of this.named) {
      if (entry.registeredAtMs < cutoff) {
        this.named.delete(name);
      }
    }
  }

  private getRestManager(): CheckpointManagerLike {
    if (this.restManager !== null) return this.restManager;
    if (this.baseUrl === null) {
      throw new Error(
        "[checkpoint-manager] baseUrl is null; call setBaseUrl() after starting llama-server",
      );
    }
    this.restManager = new RestCheckpointManager({
      baseUrl: this.baseUrl,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.requestTimeoutMs }
        : {}),
      ...(this.resolveSlotId ? { resolveSlotId: this.resolveSlotId } : {}),
    });
    return this.restManager;
  }

  private getCapabilityClient(): CheckpointClient {
    if (this.capabilityClient !== null) return this.capabilityClient;
    if (this.baseUrl === null) {
      throw new Error(
        "[checkpoint-manager] baseUrl is null; call setBaseUrl() before detectCapability()",
      );
    }
    this.capabilityClient = new CheckpointClient({
      baseUrl: this.baseUrl,
      ...(this.fetchImpl ? { fetchImpl: this.fetchImpl } : {}),
      ...(this.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.requestTimeoutMs }
        : {}),
    });
    return this.capabilityClient;
  }
}

/**
 * Wrap a numeric slot id as the string form `voice/checkpoint-manager.ts`
 * expects. Voice callers carry a string-form id throughout (so per-
 * conversation slots round-trip cleanly); the gated layer's public
 * surface is integer-keyed because the REST endpoints are.
 */
function restSlotIdString(slotId: number): string {
  return `s${slotId}`;
}

/**
 * Build a one-shot checkpoint name for `cancel(slotId)`. Each cancel call
 * needs a unique name so the inner `MockCheckpointManager` / REST manager
 * doesn't dedupe — appended with the monotonic clock value.
 */
function cancelSentinelName(slotId: number, nowMs: number): string {
  return `cancel-s${slotId}-${nowMs.toString(36)}`;
}
