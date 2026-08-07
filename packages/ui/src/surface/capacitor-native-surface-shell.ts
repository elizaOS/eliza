/**
 * Capacitor-backed {@link NativeSurfaceShell} — the on-device driver that turns
 * per-tab surface commands into real layered native web surfaces (#15245). It
 * forwards each command to the `ElizaSurfaceManager` Capacitor plugin, whose iOS
 * side layers `WKWebView`s (an isolated surface gets its own `WKProcessPool` +
 * non-persistent `WKWebsiteDataStore`; a shared surface reuses a plugin-owned
 * pool/store) and whose Android side layers `WebView`s with the matching
 * out-of-process renderer + androidx.webkit profile partitioning.
 *
 * The plugin is modelled structurally through `getNativePlugin` — the same
 * pattern every other native bridge here uses (`native-plugins.ts`) — so the
 * renderer never imports the native Capacitor package directly. The explicit
 * {@link NativeSurfacePolicy} the placement decision computed is passed through
 * verbatim as `process`/`storage` fields; the native side must honour them and
 * never fall back to a platform default (#15245 invariant).
 *
 * Commands stay synchronous from the React caller's viewpoint, but this driver
 * serializes them per surface behind an acknowledged native create. A surface
 * is not reported live until that acknowledgement arrives, and geometry is
 * deduplicated only after native acceptance. This prevents a slow or transiently
 * rejected create from losing the initial bounds, overlay holes, or foreground
 * command. Rejected transport work is surfaced through {@link logger} rather
 * than thrown into React render/effects; this is the J1 boundary.
 */

import { logger } from "@elizaos/logger";
import { getNativePlugin } from "../bridge/native-plugins";
import type {
  NativeSurfaceCreateRequest,
  NativeSurfaceShell,
  SurfaceBounds,
  SurfaceOcclusionRect,
} from "./native-surface-shell";

/**
 * The native `ElizaSurfaceManager` plugin surface. Each method maps 1:1 to a
 * {@link NativeSurfaceShell} command. The driver mirrors acknowledged native
 * state so synchronous `hasSurface` never guesses that an in-flight create is
 * already usable.
 */
export interface ElizaSurfaceManagerPlugin {
  // Structural index signature so this satisfies `getNativePlugin`'s
  // `Record<string, unknown>` constraint (the bridge models native plugins
  // structurally, not by importing the Capacitor package).
  [key: string]: unknown;
  createSurface(options: {
    id: string;
    url?: string;
    process: "isolated" | "shared";
    storage: "isolated" | "shared";
  }): Promise<void>;
  setBounds(options: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    outerClip: SurfaceBounds["outerClip"];
  }): Promise<void>;
  setOcclusionRects(options: {
    id: string;
    rects: readonly SurfaceOcclusionRect[];
  }): Promise<void>;
  navigate(options: { id: string; url: string }): Promise<void>;
  foregroundSurface(options: { id: string }): Promise<void>;
  backgroundSurface(options: { id: string }): Promise<void>;
  destroySurface(options: { id: string }): Promise<void>;
  foregroundHost(): Promise<void>;
}

function plugin(): ElizaSurfaceManagerPlugin {
  return getNativePlugin<ElizaSurfaceManagerPlugin>("ElizaSurfaceManager");
}

function report(op: string, error: unknown): void {
  // error-policy:J1 native surface transport boundary — a failed layer op is
  // logged, not rethrown into React render/effects, so a Browser-view
  // navigation cannot wedge on a native bridge hiccup.
  logger.error({ error }, `[CapacitorNativeSurfaceShell] ${op} failed`);
}

/**
 * Drives layered native surfaces through the Capacitor `ElizaSurfaceManager`
 * plugin. Construct one per Browser view and hand it to
 * {@link useMobileNativeTabSurfaces}. Its acknowledged state answers
 * synchronous `hasSurface` without a native round-trip.
 */
export class CapacitorNativeSurfaceShell implements NativeSurfaceShell {
  private readonly surfaces = new Map<string, SurfaceCommandState>();

  constructor(
    private readonly getNativeManager: () => ElizaSurfaceManagerPlugin = plugin,
  ) {}

  createSurface(req: NativeSurfaceCreateRequest): void {
    if (this.surfaces.has(req.id)) return;
    const state: SurfaceCommandState = {
      accepted: false,
      closing: false,
      createAttempts: 0,
      lastBoundsKey: null,
      lastOcclusionKey: null,
      tail: Promise.resolve(),
    };
    this.surfaces.set(req.id, state);
    state.tail = this.createWithRetry(req, state).then(
      () => undefined,
      (error) => {
        if (this.surfaces.get(req.id) === state) {
          this.surfaces.delete(req.id);
        }
        report(`createSurface(${req.id})`, error);
      },
    );
  }

  setBounds(id: string, bounds: SurfaceBounds): void {
    const key = JSON.stringify(bounds);
    this.enqueue(id, `setBounds(${id})`, async (state) => {
      if (state.lastBoundsKey === key) return;
      await this.getNativeManager().setBounds({ id, ...bounds });
      state.lastBoundsKey = key;
    });
  }

  setOcclusionRects(id: string, rects: readonly SurfaceOcclusionRect[]): void {
    const key = JSON.stringify(rects);
    this.enqueue(id, `setOcclusionRects(${id})`, async (state) => {
      if (state.lastOcclusionKey === key) return;
      await this.getNativeManager().setOcclusionRects({ id, rects });
      state.lastOcclusionKey = key;
    });
  }

  navigate(id: string, url: string): void {
    this.enqueue(id, `navigate(${id})`, () =>
      this.getNativeManager().navigate({ id, url }),
    );
  }

  foregroundSurface(id: string): void {
    this.enqueue(id, `foregroundSurface(${id})`, () =>
      this.getNativeManager().foregroundSurface({ id }),
    );
  }

  backgroundSurface(id: string): void {
    this.enqueue(id, `backgroundSurface(${id})`, () =>
      this.getNativeManager().backgroundSurface({ id }),
    );
  }

  destroySurface(id: string): void {
    const state = this.surfaces.get(id);
    if (!state || state.closing) return;
    state.closing = true;
    state.tail = state.tail.then(
      async () => {
        if (this.surfaces.get(id) !== state || !state.accepted) return;
        await this.getNativeManager().destroySurface({ id });
      },
      () => undefined,
    );
    state.tail = state.tail.then(
      () => {
        if (this.surfaces.get(id) === state) this.surfaces.delete(id);
      },
      (error) => {
        if (this.surfaces.get(id) === state) this.surfaces.delete(id);
        report(`destroySurface(${id})`, error);
      },
    );
  }

  foregroundHost(): void {
    Promise.resolve()
      .then(() => this.getNativeManager().foregroundHost())
      .catch((error) => report("foregroundHost", error));
  }

  hasSurface(id: string): boolean {
    const state = this.surfaces.get(id);
    return state?.accepted === true && !state.closing;
  }

  private createWithRetry(
    req: NativeSurfaceCreateRequest,
    state: SurfaceCommandState,
  ): Promise<void> {
    const attempt = (): Promise<void> => {
      state.createAttempts += 1;
      return Promise.resolve()
        .then(() =>
          this.getNativeManager().createSurface({
            id: req.id,
            url: req.url,
            process: req.policy.process,
            storage: req.policy.storage,
          }),
        )
        .then(
          () => {
            if (this.surfaces.get(req.id) === state) {
              state.accepted = true;
            }
          },
          (error) => {
            if (
              this.surfaces.get(req.id) === state &&
              !state.closing &&
              state.createAttempts < MAX_CREATE_ATTEMPTS
            ) {
              return attempt();
            }
            return Promise.reject(error);
          },
        );
    };
    return attempt();
  }

  private enqueue(
    id: string,
    op: string,
    command: (state: SurfaceCommandState) => Promise<void>,
  ): void {
    const state = this.surfaces.get(id);
    if (!state || state.closing) return;
    state.tail = state.tail.then(async () => {
      if (this.surfaces.get(id) !== state || !state.accepted || state.closing) {
        return;
      }
      await command(state);
    });
    state.tail = state.tail.then(
      () => undefined,
      (error) => report(op, error),
    );
  }
}

const MAX_CREATE_ATTEMPTS = 2;

interface SurfaceCommandState {
  accepted: boolean;
  closing: boolean;
  createAttempts: number;
  lastBoundsKey: string | null;
  lastOcclusionKey: string | null;
  tail: Promise<void>;
}
