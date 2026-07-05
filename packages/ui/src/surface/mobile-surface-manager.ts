/**
 * Mobile surface manager — layers major views as native-shell surfaces driven
 * entirely by the resolved {@link SurfaceManifest} (#14182, child of #13452).
 *
 * On mobile every view renders into a single host web surface unless its
 * manifest declares `isolation: "native-webview"`, in which case the manager
 * hands it its own layered native web surface with an explicit process/storage
 * policy (see `native-surface-shell.ts`). The manager also honours the
 * manifest's {@link SurfaceLifecyclePolicy}: a `retained` view is kept warm in
 * the background when navigated away from and restored without a reload, an
 * `ephemeral` view is torn down after an idle grace window, and BOTH are evicted
 * under real memory pressure — the exact policy the type documents.
 *
 * Every decision is read from the manifest at {@link MobileSurfaceManager.activate}
 * time; the manager holds no policy of its own. That is deliberate: the mobile
 * behaviour is the same declared contract as desktop/web (`resolveSurfaceManifest`
 * is the single source), not a mobile-only fork, so changing a view's
 * `isolation`/`lifecycle` changes mobile placement and retention with no code
 * change here.
 *
 * The manager depends only on the {@link NativeSurfaceShell} seam and an
 * injectable clock/scheduler, so it runs headless in a test with a faithful
 * in-memory shell and fake timers — which is how the isolation guarantee (state
 * written in one surface cannot be read from the host or a sibling) is proven
 * without a device.
 */

import {
  type ResolvedSurfaceManifest,
  resolveSurfaceManifest,
  type SurfaceManifestBearer,
} from "@elizaos/core";
import { logger } from "@elizaos/logger";
import {
  deriveSurfacePlacement,
  type NativeSurfacePolicy,
  type NativeSurfaceShell,
  type SurfacePlacement,
} from "./native-surface-shell";

/** A view the manager can activate: a stable id plus its surface declaration. */
export interface SurfaceView {
  /** Stable identity across activations (the retention key). */
  readonly id: string;
  /**
   * The view's surface declaration (or the whole registration that bears one).
   * Resolved through {@link resolveSurfaceManifest} on every activation, so a
   * change to `surface.isolation` / `surface.lifecycle` changes the outcome.
   */
  readonly manifest: SurfaceManifestBearer | null | undefined;
  /** Initial URL for a native-surface view, when known (e.g. Browser). */
  readonly url?: string;
}

/** The outcome of activating a view — what the manager decided and did. */
export interface SurfaceActivation {
  readonly viewId: string;
  readonly placement: SurfacePlacement;
  /** A brand-new native surface was created (cold load). */
  readonly created: boolean;
  /** An existing backgrounded native surface was restored without a reload. */
  readonly restoredWarm: boolean;
}

/** Live state of a tracked native surface. `host-web` views are not tracked. */
type SurfaceStatus = "foreground" | "background" | "destroyed";

interface TrackedSurface {
  readonly viewId: string;
  readonly policy: NativeSurfacePolicy;
  readonly lifecycle: ResolvedSurfaceManifest["lifecycle"];
  status: SurfaceStatus;
  /** Pending ephemeral teardown handle, if any. */
  teardownTimer: ReturnType<typeof setTimeout> | null;
}

/** What currently occupies the foreground: the host web surface or a view id. */
type Foreground = { kind: "host" } | { kind: "surface"; viewId: string };

export interface MobileSurfaceManagerOptions {
  /**
   * How long an `ephemeral` native surface survives after being backgrounded
   * before teardown. Default 30s — long enough that a quick tab-away-and-back
   * does not pay a reload, short enough that idle heavy surfaces are reclaimed.
   */
  readonly idleGraceMs?: number;
  /** Injectable timer seam so tests drive teardown with fake timers. */
  readonly setTimeoutFn?: typeof setTimeout;
  readonly clearTimeoutFn?: typeof clearTimeout;
}

const DEFAULT_IDLE_GRACE_MS = 30_000;

/**
 * Owns the native surface stack for one app shell. Not reentrant — call from the
 * shell's navigation reducer, one activation at a time.
 */
export class MobileSurfaceManager {
  private readonly shell: NativeSurfaceShell;
  private readonly idleGraceMs: number;
  private readonly setTimeoutFn: typeof setTimeout;
  private readonly clearTimeoutFn: typeof clearTimeout;
  private readonly surfaces = new Map<string, TrackedSurface>();
  private foreground: Foreground = { kind: "host" };

  constructor(
    shell: NativeSurfaceShell,
    options: MobileSurfaceManagerOptions = {},
  ) {
    this.shell = shell;
    this.idleGraceMs = options.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
    this.setTimeoutFn = options.setTimeoutFn ?? setTimeout;
    this.clearTimeoutFn = options.clearTimeoutFn ?? clearTimeout;
  }

  /**
   * Bring `view` to the foreground, applying the departing view's lifecycle
   * first. Reads the manifest fresh, so the placement and retention are always
   * whatever the current declaration resolves to.
   */
  activate(view: SurfaceView): SurfaceActivation {
    const manifest = resolveSurfaceManifest(view.manifest);
    const placement = deriveSurfacePlacement(manifest);

    this.retireForeground(view.id);

    if (placement.target === "host-web") {
      this.shell.foregroundHost();
      this.foreground = { kind: "host" };
      return {
        viewId: view.id,
        placement,
        created: false,
        restoredWarm: false,
      };
    }

    const existing = this.surfaces.get(view.id);
    if (existing && existing.status !== "destroyed") {
      // Warm restore: cancel any pending teardown and re-foreground the live
      // surface — no create, no reload.
      this.cancelTeardown(existing);
      existing.status = "foreground";
      this.shell.foregroundSurface(view.id);
      this.foreground = { kind: "surface", viewId: view.id };
      logger.debug(
        `[MobileSurfaceManager] restored warm native surface "${view.id}"`,
      );
      return { viewId: view.id, placement, created: false, restoredWarm: true };
    }

    this.shell.createSurface({
      id: view.id,
      url: view.url,
      policy: placement.policy,
    });
    this.shell.foregroundSurface(view.id);
    this.surfaces.set(view.id, {
      viewId: view.id,
      policy: placement.policy,
      lifecycle: manifest.lifecycle,
      status: "foreground",
      teardownTimer: null,
    });
    this.foreground = { kind: "surface", viewId: view.id };
    logger.debug(
      `[MobileSurfaceManager] created native surface "${view.id}" ` +
        `(process=${placement.policy.process}, storage=${placement.policy.storage}, ` +
        `lifecycle=${manifest.lifecycle})`,
    );
    return { viewId: view.id, placement, created: true, restoredWarm: false };
  }

  /**
   * Evict every backgrounded native surface — retained and ephemeral alike —
   * under real memory pressure, keeping only the foreground. This is the
   * "still evicts under real memory pressure" clause the lifecycle type
   * documents; retention is a preference, not a guarantee.
   */
  onMemoryPressure(): void {
    let evicted = 0;
    for (const surface of this.surfaces.values()) {
      if (surface.status === "background") {
        this.teardown(surface);
        evicted += 1;
      }
    }
    if (evicted > 0) {
      logger.debug(
        `[MobileSurfaceManager] evicted ${evicted} backgrounded native surface(s) under memory pressure`,
      );
    }
  }

  /** The current foreground view id, or `null` when the host is foreground. */
  getForegroundViewId(): string | null {
    return this.foreground.kind === "surface" ? this.foreground.viewId : null;
  }

  /** Live status of a tracked native surface, or `null` if untracked/destroyed. */
  getSurfaceStatus(viewId: string): SurfaceStatus | null {
    const surface = this.surfaces.get(viewId);
    if (!surface || surface.status === "destroyed") return null;
    return surface.status;
  }

  /** The explicit policy a native surface was created with, for introspection. */
  getSurfacePolicy(viewId: string): NativeSurfacePolicy | null {
    const surface = this.surfaces.get(viewId);
    return surface && surface.status !== "destroyed" ? surface.policy : null;
  }

  /**
   * Apply the departing foreground view's lifecycle policy before something else
   * takes the foreground. A `retained` surface is backgrounded warm; an
   * `ephemeral` one is scheduled for teardown after the idle grace window.
   * The host needs no retirement — it is always present behind the stack.
   */
  private retireForeground(incomingViewId: string): void {
    if (this.foreground.kind !== "surface") return;
    const outgoingId = this.foreground.viewId;
    if (outgoingId === incomingViewId) return;

    const surface = this.surfaces.get(outgoingId);
    if (!surface || surface.status === "destroyed") return;

    surface.status = "background";
    this.shell.backgroundSurface(outgoingId);

    if (surface.lifecycle === "retained") {
      return;
    }
    // Ephemeral: schedule teardown after the grace window. A return-visit
    // before it fires cancels it (see the warm-restore path in activate).
    surface.teardownTimer = this.setTimeoutFn(() => {
      surface.teardownTimer = null;
      if (surface.status === "background") {
        this.teardown(surface);
        logger.debug(
          `[MobileSurfaceManager] tore down ephemeral native surface "${outgoingId}" after idle grace`,
        );
      }
    }, this.idleGraceMs);
  }

  private cancelTeardown(surface: TrackedSurface): void {
    if (surface.teardownTimer !== null) {
      this.clearTimeoutFn(surface.teardownTimer);
      surface.teardownTimer = null;
    }
  }

  private teardown(surface: TrackedSurface): void {
    this.cancelTeardown(surface);
    surface.status = "destroyed";
    this.shell.destroySurface(surface.viewId);
    this.surfaces.delete(surface.viewId);
  }
}
