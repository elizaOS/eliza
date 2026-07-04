/**
 * ViewLifecycleController — the single state machine + registry for every routed
 * view in the app shell (issue #10202).
 *
 * THE problem this solves: today switching tabs simply unmounts the old view
 * subtree and mounts the new one (App.tsx ViewRouter), and three places
 * (retained-lazy.tsx, DynamicViewLoader.tsx, GameViewOverlay.tsx) each
 * re-implement their own visibility/memory-pressure pause+evict listeners. This
 * controller centralizes the lifecycle: it owns each view's
 * mount/show/hide/pause/resume/evict/restore/crash phase, a bounded LRU over
 * retained (keep-alive) views with explicit pinned exemptions, and ONE set of
 * APP_PAUSE/APP_RESUME/visibility/memorypressure listeners that pause and evict
 * retained instances.
 *
 * It is a module singleton keyed on `globalThis` (mirroring app-shell-registry)
 * so a single instance survives Fast Refresh and is shared by the host, the
 * per-view hook, and the telemetry profiler.
 *
 * The CONTROLLER decides which views are retained and their phases; the HOST
 * (`KeepAliveViewHost`) renders exactly `getRenderSet()` and reacts to changes
 * via `subscribe`. Slots are passive (provide context + hidden/inert).
 */

import { logger } from "@elizaos/logger";
import { emitModuleCacheTelemetry } from "../cache-telemetry";
import { APP_PAUSE_EVENT, APP_RESUME_EVENT } from "../events";
import {
  getKeepAliveMaxViews,
  getKeepAliveTtlMs,
  selectLruEvictions,
} from "./bounded-view-lru";
import {
  DEFAULT_VIEW_LIFECYCLE_POLICY,
  type EvictReason,
  type ViewLifecycleListener,
  type ViewLifecyclePhase,
  type ViewLifecyclePolicy,
  type ViewLifecycleTransition,
} from "./view-lifecycle-types";

/**
 * Views that must never be evicted. chat (ContinuousChatOverlay/HomeScreenMount)
 * and background (AppBackground) already live structurally OUTSIDE the routed
 * host, so they are inherently retained; the controller additionally refuses to
 * ever evict these ids. This is the single, explicit exemption surface
 * (acceptance criterion #3).
 */
export const PINNED_VIEW_IDS: ReadonlySet<string> = new Set([
  "chat",
  "background",
]);

/**
 * Builtin per-view retention overrides. Most builtin views keep today's
 * unmount-on-hide default (keepAlive:false). A curated few that are cheap to
 * retain and expensive to rebuild opt into keep-alive. Pinned views are also
 * marked here so a direct policy lookup reflects their exemption.
 */
const BUILTIN_VIEW_POLICY: Record<string, Partial<ViewLifecyclePolicy>> = {
  chat: { keepAlive: true, pausable: false, pinned: true },
  background: { keepAlive: true, pausable: false, pinned: true },
};

/** Runtime policy overrides (e.g. a plugin page declaring keepAlive). */
const policyOverrides = new Map<string, Partial<ViewLifecyclePolicy>>();

/**
 * Register a runtime retention-policy override for a view id (used by
 * app-shell-registry when a plugin page declares keepAlive/pausable). Merged
 * over the builtin policy + the default.
 */
export function registerViewPolicy(
  viewId: string,
  policy: Partial<ViewLifecyclePolicy>,
): void {
  policyOverrides.set(viewId, { ...policyOverrides.get(viewId), ...policy });
}

/** Resolve the effective retention policy for a view id. */
export function resolveViewLifecyclePolicy(
  viewId: string,
): ViewLifecyclePolicy {
  const pinned = PINNED_VIEW_IDS.has(viewId);
  return {
    ...DEFAULT_VIEW_LIFECYCLE_POLICY,
    ...BUILTIN_VIEW_POLICY[viewId],
    ...policyOverrides.get(viewId),
    // PINNED_VIEW_IDS membership is authoritative for the pinned flag.
    ...(pinned ? { pinned: true, keepAlive: true } : {}),
  };
}

interface ViewLifecycleRecord {
  viewId: string;
  phase: ViewLifecyclePhase;
  policy: ViewLifecyclePolicy;
  lastActiveAt: number;
  /** TTL eviction timer for a retained-but-hidden keep-alive view. */
  retentionTimer: ReturnType<typeof setTimeout> | null;
  listeners: Set<ViewLifecycleListener>;
}

export interface ViewRenderSet {
  activeId: string | null;
  /** All ids the host should render: active + retained keep-alive (sorted). */
  retainedIds: string[];
}

type HostListener = () => void;

class ViewLifecycleController {
  private readonly records = new Map<string, ViewLifecycleRecord>();
  private activeId: string | null = null;
  private readonly hostListeners = new Set<HostListener>();
  private snapshot: ViewRenderSet = { activeId: null, retainedIds: [] };
  private signalsInstalled = false;
  private onAppPause: (() => void) | null = null;
  private onAppResume: (() => void) | null = null;
  private onVisibilityChange: (() => void) | null = null;
  private onMemoryPressure: (() => void) | null = null;
  /** Injectable clock so tests are deterministic. */
  now: () => number = () => Date.now();

  private ensureRecord(viewId: string): ViewLifecycleRecord {
    let record = this.records.get(viewId);
    if (!record) {
      record = {
        viewId,
        phase: "mounted",
        policy: resolveViewLifecyclePolicy(viewId),
        lastActiveAt: this.now(),
        retentionTimer: null,
        listeners: new Set(),
      };
      this.records.set(viewId, record);
    } else {
      // Re-resolve in case a policy override was registered after first mount.
      record.policy = resolveViewLifecyclePolicy(viewId);
    }
    return record;
  }

  private transition(
    record: ViewLifecycleRecord,
    phase: ViewLifecyclePhase,
    reason?: ViewLifecycleTransition["reason"],
  ): void {
    const previousPhase = record.phase;
    if (previousPhase === phase) return;
    record.phase = phase;
    const transition: ViewLifecycleTransition = {
      viewId: record.viewId,
      phase,
      previousPhase,
      reason,
      at: this.now(),
    };
    logger.info(
      `[ViewLifecycle] "${record.viewId}" ${previousPhase} → ${phase}` +
        (reason ? ` (${reason})` : ""),
    );
    for (const listener of record.listeners) {
      try {
        listener(transition);
      } catch (error) {
        logger.error(
          `[ViewLifecycle] listener for "${record.viewId}" threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  /** Recompute + publish the host render set if it changed. */
  private publish(): void {
    const retainedIds = [...this.records.keys()]
      .filter((id) => {
        const record = this.records.get(id);
        // Pinned views (chat/background) are STRUCTURAL surfaces rendered
        // OUTSIDE the routed host (ContinuousChatOverlay/AppBackground); the
        // host only renders them when they are the active tab. Their "retained"
        // guarantee is that their record is never evicted — not that the routed
        // host paints a hidden slot for them (which would be an empty,
        // unrenderable slot — see #10202 review).
        if (id === this.activeId) return true;
        return record?.policy.keepAlive === true && !record.policy.pinned;
      })
      .sort();
    const next: ViewRenderSet = { activeId: this.activeId, retainedIds };
    const changed =
      next.activeId !== this.snapshot.activeId ||
      next.retainedIds.length !== this.snapshot.retainedIds.length ||
      next.retainedIds.some((id, i) => id !== this.snapshot.retainedIds[i]);
    if (!changed) return;
    this.snapshot = next;
    for (const listener of this.hostListeners) {
      try {
        listener();
      } catch (error) {
        logger.error(
          `[ViewLifecycle] host listener threw: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }

  private clearRetentionTimer(record: ViewLifecycleRecord): void {
    if (record.retentionTimer !== null) {
      clearTimeout(record.retentionTimer);
      record.retentionTimer = null;
    }
  }

  private scheduleTtlEviction(record: ViewLifecycleRecord): void {
    this.clearRetentionTimer(record);
    if (record.policy.pinned) return;
    const ttl = getKeepAliveTtlMs();
    record.retentionTimer = setTimeout(() => {
      record.retentionTimer = null;
      this.evict(record.viewId, "ttl");
    }, ttl);
  }

  /** Enforce the keep-alive LRU cap, evicting the oldest non-exempt views. */
  private enforceLru(): void {
    const retained = [...this.records.values()]
      .filter((r) => r.policy.keepAlive)
      .map((r) => r.viewId);
    const exempt = new Set<string>(PINNED_VIEW_IDS);
    if (this.activeId) exempt.add(this.activeId);
    const lastActiveAt = new Map<string, number>();
    for (const id of retained) {
      lastActiveAt.set(id, this.records.get(id)?.lastActiveAt ?? 0);
    }
    const evictions = selectLruEvictions(
      retained,
      lastActiveAt,
      getKeepAliveMaxViews(),
      exempt,
    );
    for (const id of evictions) {
      this.evict(id, "lru");
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────

  /** Register a view (idempotent). Returns its resolved policy. */
  register(viewId: string): ViewLifecyclePolicy {
    return this.ensureRecord(viewId).policy;
  }

  getPolicy(viewId: string): ViewLifecyclePolicy {
    return this.ensureRecord(viewId).policy;
  }

  getPhase(viewId: string): ViewLifecyclePhase | null {
    return this.records.get(viewId)?.phase ?? null;
  }

  /**
   * Make `viewId` the active/visible view. Hides the previous active view
   * (pause+retain if keepAlive, else evict), activates the new one, then
   * enforces the LRU cap. The single host→controller command.
   */
  setActive(viewId: string): void {
    if (this.activeId === viewId) {
      const current = this.ensureRecord(viewId);
      current.lastActiveAt = this.now();
      this.transition(current, "active", "show");
      return;
    }
    const previousId = this.activeId;
    this.activeId = viewId;

    const next = this.ensureRecord(viewId);
    this.clearRetentionTimer(next);
    next.lastActiveAt = this.now();
    this.transition(next, "active", "show");

    if (previousId && previousId !== viewId) {
      const previous = this.records.get(previousId);
      if (previous) {
        if (previous.policy.keepAlive && !previous.policy.pinned) {
          // Retain hidden: pause if pausable, mark inactive, schedule TTL.
          if (previous.policy.pausable) {
            this.transition(previous, "paused", "hide");
          } else {
            this.transition(previous, "inactive", "hide");
          }
          this.scheduleTtlEviction(previous);
        } else if (previous.policy.pinned) {
          // Pinned (chat/background): hidden but never evicted, just inactive.
          this.transition(previous, "inactive", "hide");
        } else {
          // Default: unmount-on-hide (today's behavior).
          this.evict(previousId, "inactive", { skipPublish: true });
        }
      }
    }

    this.enforceLru();
    this.publish();
  }

  /** Pause a view's resources (timers/polling/media/native subs). */
  markPaused(viewId: string, reason: EvictReason = "app-pause"): void {
    const record = this.records.get(viewId);
    if (!record?.policy.pausable) return;
    this.transition(record, "paused", reason);
  }

  /** Resume a paused view. Restores active if it is the active view. */
  markResumed(viewId: string): void {
    const record = this.records.get(viewId);
    if (!record) return;
    if (record.phase !== "paused") return;
    this.transition(
      record,
      viewId === this.activeId ? "active" : "inactive",
      "resume",
    );
  }

  /** Mark a view crashed (ViewErrorBoundary caught a render throw). */
  markCrashed(viewId: string): void {
    const record = this.ensureRecord(viewId);
    this.transition(record, "crashed", "crash");
  }

  /**
   * Mark a crashed view as recovering (Retry pressed), then immediately resolve
   * it back to its resting phase. The boundary remounts a fresh subtree on
   * Retry, so the view is live again — leaving it stuck in "recovering" would
   * keep `isActive` false and never emit the recovered "active" telemetry.
   */
  markRecovering(viewId: string): void {
    const record = this.records.get(viewId);
    if (!record) return;
    this.transition(record, "recovering", "recover");
    this.transition(
      record,
      viewId === this.activeId ? "active" : "inactive",
      "resume",
    );
  }

  /**
   * Evict a view: unmount + cleanup. Refuses to evict pinned ids and the active
   * view. Emits cache telemetry on the shared module-cache channel so eviction
   * rides the existing stream.
   */
  evict(
    viewId: string,
    reason: EvictReason,
    options: { skipPublish?: boolean } = {},
  ): void {
    if (PINNED_VIEW_IDS.has(viewId)) return;
    if (viewId === this.activeId) return;
    const record = this.records.get(viewId);
    if (!record) return;
    this.clearRetentionTimer(record);
    this.transition(record, "evicted", reason);
    this.records.delete(viewId);

    const retainedCount = [...this.records.values()].filter(
      (r) => r.policy.keepAlive,
    ).length;
    emitModuleCacheTelemetry({
      source: "view-lifecycle",
      action: "evict",
      reason,
      key: viewId,
      activeCount: this.activeId ? 1 : 0,
      idleCount: retainedCount,
      cacheSize: this.records.size,
    });

    if (!options.skipPublish) this.publish();
  }

  /** Pause every pausable retained/active view (app-pause / tab hidden). */
  private pauseAll(reason: EvictReason): void {
    for (const record of this.records.values()) {
      if (record.policy.pausable && record.phase !== "paused") {
        this.transition(record, "paused", reason);
      }
    }
  }

  /**
   * Resume the ACTIVE paused view (app-resume / tab visible). Hidden retained
   * views deliberately stay "paused": that is their resting phase — `setActive`
   * pauses a pausable keep-alive view the moment it is hidden — so waking them
   * here (the old paused → "inactive" transition) restarted their timers/
   * polling/media (`usePausableInterval` gates on `isPaused`, and views restart
   * media/native subscriptions in `onResume`) while they were still hidden,
   * on every tab refocus or app foreground.
   */
  private resumeAll(): void {
    for (const record of this.records.values()) {
      if (record.phase !== "paused") continue;
      if (record.viewId === this.activeId) {
        this.transition(record, "active", "resume");
      }
    }
  }

  /** Force-evict every retained, non-active, non-pinned view (memory pressure). */
  private forceEvictRetained(reason: EvictReason): void {
    const ids = [...this.records.keys()].filter(
      (id) => id !== this.activeId && !PINNED_VIEW_IDS.has(id),
    );
    for (const id of ids) {
      const record = this.records.get(id);
      if (record?.policy.keepAlive)
        this.evict(id, reason, { skipPublish: true });
    }
    this.publish();
  }

  /**
   * Install the single shared signal bus: APP_PAUSE/APP_RESUME, document
   * visibility, and memorypressure. Replaces the per-cache copies in
   * retained-lazy / DynamicViewLoader for live VIEW instances. Idempotent.
   */
  installSignals(): void {
    if (this.signalsInstalled) return;
    if (typeof window === "undefined" || typeof document === "undefined")
      return;
    this.signalsInstalled = true;

    this.onAppPause = () => this.pauseAll("app-pause");
    this.onAppResume = () => this.resumeAll();
    this.onVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        this.pauseAll("visibility-hidden");
      } else {
        this.resumeAll();
      }
    };
    this.onMemoryPressure = () => this.forceEvictRetained("memorypressure");

    window.addEventListener(APP_PAUSE_EVENT, this.onAppPause);
    window.addEventListener(APP_RESUME_EVENT, this.onAppResume);
    document.addEventListener(APP_PAUSE_EVENT, this.onAppPause);
    document.addEventListener(APP_RESUME_EVENT, this.onAppResume);
    document.addEventListener("visibilitychange", this.onVisibilityChange);
    window.addEventListener("memorypressure", this.onMemoryPressure);
  }

  private uninstallSignals(): void {
    if (!this.signalsInstalled) return;
    if (typeof window !== "undefined") {
      if (this.onAppPause) {
        window.removeEventListener(APP_PAUSE_EVENT, this.onAppPause);
      }
      if (this.onAppResume) {
        window.removeEventListener(APP_RESUME_EVENT, this.onAppResume);
      }
      if (this.onMemoryPressure) {
        window.removeEventListener("memorypressure", this.onMemoryPressure);
      }
    }
    if (typeof document !== "undefined") {
      if (this.onAppPause) {
        document.removeEventListener(APP_PAUSE_EVENT, this.onAppPause);
      }
      if (this.onAppResume) {
        document.removeEventListener(APP_RESUME_EVENT, this.onAppResume);
      }
      if (this.onVisibilityChange) {
        document.removeEventListener(
          "visibilitychange",
          this.onVisibilityChange,
        );
      }
    }
    this.signalsInstalled = false;
    this.onAppPause = null;
    this.onAppResume = null;
    this.onVisibilityChange = null;
    this.onMemoryPressure = null;
  }

  // ── Subscriptions ─────────────────────────────────────────────────────

  /** Subscribe to host render-set changes (for useSyncExternalStore). */
  subscribe(listener: HostListener): () => void {
    this.hostListeners.add(listener);
    return () => this.hostListeners.delete(listener);
  }

  getRenderSet(): ViewRenderSet {
    return this.snapshot;
  }

  getActiveId(): string | null {
    return this.activeId;
  }

  /**
   * Ids the host actually retains hidden: keep-alive but NOT pinned (pinned
   * surfaces are structural, rendered outside the host). The active view is
   * included only if it is itself a retained keep-alive view.
   */
  getRetainedKeepAliveIds(): string[] {
    return [...this.records.values()]
      .filter((r) => r.policy.keepAlive && !r.policy.pinned)
      .map((r) => r.viewId)
      .sort();
  }

  /** Subscribe to a single view's phase transitions (for useViewLifecycle). */
  subscribeView(viewId: string, listener: ViewLifecycleListener): () => void {
    const record = this.ensureRecord(viewId);
    record.listeners.add(listener);
    return () => {
      record.listeners.delete(listener);
    };
  }

  // ── Test surface ──────────────────────────────────────────────────────

  __reset(): void {
    for (const record of this.records.values()) {
      this.clearRetentionTimer(record);
    }
    this.records.clear();
    this.activeId = null;
    this.snapshot = { activeId: null, retainedIds: [] };
    this.hostListeners.clear();
    policyOverrides.clear();
    this.uninstallSignals();
    this.now = () => Date.now();
  }
}

const GLOBAL_KEY = Symbol.for("eliza.viewLifecycleController");
type ControllerGlobal = typeof globalThis & {
  [GLOBAL_KEY]?: ViewLifecycleController;
};

function getController(): ViewLifecycleController {
  const globalObject = globalThis as ControllerGlobal;
  if (!globalObject[GLOBAL_KEY]) {
    globalObject[GLOBAL_KEY] = new ViewLifecycleController();
  }
  return globalObject[GLOBAL_KEY];
}

/** The shared, app-wide view lifecycle controller singleton. */
export const viewLifecycleController = getController();

/** Test-only: reset the controller (records, active id, listeners, signals). */
export function __resetViewLifecycleForTests(): void {
  viewLifecycleController.__reset();
}

export type { ViewLifecycleController };
