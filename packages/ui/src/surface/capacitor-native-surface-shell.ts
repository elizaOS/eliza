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
 * Commands are fire-and-forget from the caller's synchronous viewpoint: the
 * native calls return promises, and a rejected promise is surfaced via
 * {@link logger} rather than thrown back through React render/effects, because a
 * failed layer op must not wedge the Browser view mid-navigation. This is the J1
 * boundary — the one place the async native transport is translated.
 */

import { logger } from "@elizaos/logger";
import { getNativePlugin } from "../bridge/native-plugins";
import type {
  NativeSurfaceCreateRequest,
  NativeSurfaceShell,
  SurfaceBounds,
} from "./native-surface-shell";

/**
 * The native `ElizaSurfaceManager` plugin surface. Each method maps 1:1 to a
 * {@link NativeSurfaceShell} command; `hasSurface` is answered from a mirrored
 * id set on the JS side so the caller's synchronous `hasSurface` need not await
 * the bridge.
 */
interface ElizaSurfaceManagerPlugin {
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
 * {@link useMobileNativeTabSurfaces}. The mirrored `liveIds` set answers the
 * synchronous `hasSurface` without a round-trip.
 */
export class CapacitorNativeSurfaceShell implements NativeSurfaceShell {
  private readonly liveIds = new Set<string>();

  createSurface(req: NativeSurfaceCreateRequest): void {
    this.liveIds.add(req.id);
    plugin()
      .createSurface({
        id: req.id,
        url: req.url,
        process: req.policy.process,
        storage: req.policy.storage,
      })
      .catch((error) => report(`createSurface(${req.id})`, error));
  }

  setBounds(id: string, bounds: SurfaceBounds): void {
    plugin()
      .setBounds({ id, ...bounds })
      .catch((error) => report(`setBounds(${id})`, error));
  }

  navigate(id: string, url: string): void {
    plugin()
      .navigate({ id, url })
      .catch((error) => report(`navigate(${id})`, error));
  }

  foregroundSurface(id: string): void {
    plugin()
      .foregroundSurface({ id })
      .catch((error) => report(`foregroundSurface(${id})`, error));
  }

  backgroundSurface(id: string): void {
    plugin()
      .backgroundSurface({ id })
      .catch((error) => report(`backgroundSurface(${id})`, error));
  }

  destroySurface(id: string): void {
    this.liveIds.delete(id);
    plugin()
      .destroySurface({ id })
      .catch((error) => report(`destroySurface(${id})`, error));
  }

  foregroundHost(): void {
    plugin()
      .foregroundHost()
      .catch((error) => report("foregroundHost", error));
  }

  hasSurface(id: string): boolean {
    return this.liveIds.has(id);
  }
}
