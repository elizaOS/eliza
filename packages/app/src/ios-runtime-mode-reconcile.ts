/**
 * iOS persisted-runtime-mode reconcile (issue #11030).
 *
 * The renderer's transports resolve the runtime mode as
 * `localStorage["eliza:mobile-runtime-mode"]` FIRST and only then the mode
 * baked into the build. Capacitor `Preferences` and WKWebView localStorage
 * both persist across reinstalls, so a device that once ran a polluted
 * store/cloud bundle keeps `mobile-runtime-mode = "cloud"` forever — and a
 * correctly built `variant=direct / runtimeMode=local` sideload then refuses
 * local-agent IPC ("iOS cloud builds cannot use local-agent IPC unless local
 * runtime mode is active") even while the native local agent is RUNNING. The
 * startup poll can never reach a backend and the app hangs on "Booting up…"
 * (the exact real-device failure captured on issue #11030).
 *
 * A persisted cloud mode is only meaningful when there is a genuinely REMOTE
 * backend to talk to — a committed remote/cloud active server
 * (`elizaos:active-server`, see `AppContext.setActiveServerProfile`). A cloud
 * mode whose active server is absent — or is the LOCAL on-device agent entry —
 * is contradictory state on a build that bakes `runtimeMode=local`: the mode
 * blocks the on-device agent, and the boot-time active-server reconcile
 * (`reconcileMobileRestoredActiveServer`) clears a local server that disagrees
 * with the mode, leaving nothing to boot against. Reset it to the build's own
 * mode so the device heals itself instead of hanging.
 */

import {
  isMobileLocalAgentIpcBase,
  isMobileLocalAgentUrl,
  normalizeMobileRuntimeMode,
  persistMobileRuntimeModeForServerTarget,
} from "@elizaos/ui/first-run/mobile-runtime-mode";

// Mirror of `ACTIVE_SERVER_STORAGE_KEY` in `@elizaos/ui/state/persistence` —
// mirrored (like `first-run/pre-seed-local-runtime.ts` does) so this module
// stays a leaf and does not pull the whole UI state graph into the boot path.
const ACTIVE_SERVER_STORAGE_KEY = "elizaos:active-server";

export interface PersistedActiveServer {
  id: string;
  kind?: string;
  apiBase?: string;
}

export interface IosRuntimeModeReconcileInput {
  /** True only on native iOS (Capacitor). */
  isNativeIos: boolean;
  /** The runtime mode baked into this build (resolved from Vite env). */
  bakedRuntimeMode: string;
  /** Raw persisted `eliza:mobile-runtime-mode` value (localStorage). */
  persistedMode: string | null;
  /** Parsed `elizaos:active-server` payload, or null when absent/invalid. */
  activeServer: PersistedActiveServer | null;
}

/**
 * Whether a persisted active server is the bundled on-device agent (id
 * `local:*`, kind `local`, or an `eliza-local-agent://ipc` / loopback:31337
 * apiBase) rather than a genuinely remote/cloud backend.
 */
export function isLocalAgentActiveServer(
  server: PersistedActiveServer | null,
): boolean {
  if (!server) return false;
  if (server.kind === "local") return true;
  if (server.id.startsWith("local:")) return true;
  const apiBase = server.apiBase?.trim();
  if (!apiBase) return false;
  return isMobileLocalAgentIpcBase(apiBase) || isMobileLocalAgentUrl(apiBase);
}

/**
 * Pure decision: should the persisted runtime mode be reset to "local"?
 *
 * Only the poisoned state resets: a local build (baked mode `local`) carrying
 * a persisted `cloud` / `cloud-hybrid` mode with no REMOTE backend to serve
 * it — i.e. no active server at all (the #11030 device console showed
 * `mobile-runtime-mode="cloud"` with `elizaos:active-server=null`), or an
 * active server that is itself the local on-device agent (a contradiction the
 * boot-time active-server reconcile resolves by clearing the server, which
 * leaves the boot with nothing to poll). A genuinely remote/cloud active
 * server is always respected, as are the explicit `remote-mac` and
 * `tunnel-to-mobile` modes.
 */
export function shouldResetPoisonedIosRuntimeMode({
  isNativeIos,
  bakedRuntimeMode,
  persistedMode,
  activeServer,
}: IosRuntimeModeReconcileInput): boolean {
  if (!isNativeIos) return false;
  if (bakedRuntimeMode !== "local") return false;
  const normalized = normalizeMobileRuntimeMode(persistedMode);
  if (normalized !== "cloud" && normalized !== "cloud-hybrid") return false;
  if (!activeServer) return true;
  return isLocalAgentActiveServer(activeServer);
}

export function readPersistedActiveServer(
  storage: Pick<Storage, "getItem"> | null | undefined,
): PersistedActiveServer | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(ACTIVE_SERVER_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, unknown> | null;
    if (
      parsed == null ||
      typeof parsed !== "object" ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      return null;
    }
    return {
      id: parsed.id,
      ...(typeof parsed.kind === "string" ? { kind: parsed.kind } : {}),
      ...(typeof parsed.apiBase === "string"
        ? { apiBase: parsed.apiBase }
        : {}),
    };
  } catch {
    return null;
  }
}

export interface ReconcileIosRuntimeModeOptions {
  isNativeIos: boolean;
  bakedRuntimeMode: string;
  storage?: Pick<Storage, "getItem"> | null;
  persistLocalMode?: () => void;
  log?: (message: string) => void;
}

/**
 * Boot-time reconcile. Call on native iOS AFTER the storage bridge hydrated
 * localStorage from Capacitor Preferences and BEFORE React mounts, so every
 * transport-mode read in this session sees the healed value.
 *
 * Always logs its decision on iOS local builds (single line) so a stuck
 * device's boot console shows exactly which persisted state was found —
 * on-device localStorage is otherwise invisible without Web Inspector.
 *
 * @returns true when the poisoned mode was reset to "local".
 */
export function reconcileIosLocalBuildRuntimeMode({
  isNativeIos,
  bakedRuntimeMode,
  storage = typeof window === "undefined" ? null : window.localStorage,
  persistLocalMode = () => persistMobileRuntimeModeForServerTarget("local"),
  log = (message) => console.warn(message),
}: ReconcileIosRuntimeModeOptions): boolean {
  if (!isNativeIos || bakedRuntimeMode !== "local") return false;
  let persistedMode: string | null = null;
  try {
    persistedMode = storage?.getItem("eliza:mobile-runtime-mode") ?? null;
  } catch {
    persistedMode = null;
  }
  const activeServer = readPersistedActiveServer(storage);
  const reset = shouldResetPoisonedIosRuntimeMode({
    isNativeIos,
    bakedRuntimeMode,
    persistedMode,
    activeServer,
  });
  const state =
    `persistedMode=${persistedMode ?? "unset"} ` +
    `activeServer=${activeServer ? `${activeServer.id} (${activeServer.kind ?? "?"}, ${activeServer.apiBase ?? "no apiBase"})` : "none"}`;
  if (!reset) {
    log(`[ios-runtime-mode-reconcile] keeping persisted state (${state})`);
    return false;
  }
  persistLocalMode();
  log(
    `[ios-runtime-mode-reconcile] Reset persisted runtime mode '${persistedMode}' → 'local' (${state}): ` +
      `this build bakes runtimeMode=local and the persisted cloud mode has no remote backend to ` +
      `serve it (left behind by an earlier cloud/store install), so it could only hang the boot (#11030).`,
  );
  return true;
}
