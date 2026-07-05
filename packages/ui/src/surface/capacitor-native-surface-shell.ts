/**
 * Capacitor-backed {@link NativeSurfaceShell} — the on-device driver that turns
 * the manager's placement decisions into real layered native web surfaces
 * (#14182). It forwards each command to the `ElizaSurfaceManager` Capacitor
 * plugin, whose iOS side layers `WKWebView`s (an isolated surface gets its own
 * `WKProcessPool` + non-persistent `WKWebsiteDataStore`; a shared surface reuses
 * the host's) and whose Android side layers `WebView`s with the matching
 * renderer/storage partitioning.
 *
 * The plugin is modelled structurally through `getNativePlugin` — the same
 * pattern every other native bridge here uses (`native-plugins.ts`) — so the
 * renderer never imports the native Capacitor package directly. The explicit
 * {@link NativeSurfacePolicy} the manager computed is passed through verbatim as
 * `process`/`storage` fields; the native side must honour them and never fall
 * back to a platform default (#14182 invariant).
 *
 * Commands are fire-and-forget from the manager's synchronous viewpoint: the
 * native calls return promises, and a rejected promise is surfaced to the agent
 * via {@link logger} rather than thrown back through the navigation reducer,
 * because a failed layer op must not wedge the shell mid-navigation. This is a
 * J1 boundary — the one place the async native transport is translated.
 */

import { logger } from "@elizaos/logger";
import { getNativePlugin } from "../bridge/native-plugins";
import type {
  NativeSurfaceCreateRequest,
  NativeSurfaceShell,
} from "./native-surface-shell";

/**
 * The native `ElizaSurfaceManager` plugin surface. Each method maps 1:1 to a
 * {@link NativeSurfaceShell} command; `hasSurface` is answered from a mirrored
 * id set on the JS side so the manager's synchronous `hasSurface` need not await
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
  // logged, not rethrown into the navigation reducer, so a shell navigation
  // cannot wedge on a native bridge hiccup.
  logger.error({ error }, `[CapacitorNativeSurfaceShell] ${op} failed`);
}

/**
 * Drives layered native surfaces through the Capacitor `ElizaSurfaceManager`
 * plugin. Construct one per app shell and hand it to
 * {@link MobileSurfaceManager}. The mirrored `liveIds` set answers the
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
