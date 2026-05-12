import { getElectrobunRendererRpc } from "./electrobun-rpc";

type ElectrobunBrowserWindow = Window & {
  __electrobunWindowId?: number;
  __electrobunWebviewId?: number;
};

function getRuntimeWindow(): ElectrobunBrowserWindow | null {
  const g = globalThis as typeof globalThis & {
    window?: ElectrobunBrowserWindow;
  };
  if (typeof g.window !== "undefined") {
    return g.window;
  }
  if (typeof window !== "undefined") {
    return window as ElectrobunBrowserWindow;
  }
  return null;
}

function hasElectrobunRendererBridge(): boolean {
  const rpc = getElectrobunRendererRpc();
  return Boolean(
    rpc &&
      typeof rpc.onMessage === "function" &&
      rpc.request &&
      typeof rpc.request === "object",
  );
}

export function isElectrobunRuntime(): boolean {
  const runtimeWindow = getRuntimeWindow();
  if (!runtimeWindow) {
    return false;
  }

  if (
    typeof runtimeWindow.__electrobunWindowId === "number" ||
    typeof runtimeWindow.__electrobunWebviewId === "number"
  ) {
    return true;
  }

  // Preload injects `__ELIZA_ELECTROBUN_RPC__` before (or without) Electrobun window/webview ids.
  // Without this, tray/menu IPC subscribers never register and menu Reset appears to do nothing.
  return hasElectrobunRendererBridge();
}

function isCapacitorNativePlatform(): boolean {
  try {
    // Lazy import keeps @capacitor/core out of the desktop / web bundle
    // graph. @elizaos/ui declares @capacitor/core as a devDependency, so
    // the import only resolves when a Capacitor app (mobile native) is
    // the consumer; everywhere else this throws and we fall through.
    const cap = (
      globalThis as unknown as {
        Capacitor?: {
          isNativePlatform?: () => boolean;
          getPlatform?: () => string;
        };
      }
    ).Capacitor;
    if (!cap) return false;
    if (typeof cap.isNativePlatform === "function" && cap.isNativePlatform()) {
      return true;
    }
    if (typeof cap.getPlatform === "function") {
      const p = cap.getPlatform();
      return p === "ios" || p === "android";
    }
    return false;
  } catch {
    return false;
  }
}

export function getBackendStartupTimeoutMs(): number {
  if (isElectrobunRuntime()) return 180_000;
  // Any build that hosts the on-device agent in the same process gets
  // the 3-minute budget. Three paths qualify:
  //  - Electrobun desktop (handled above)
  //  - AOSP / branded ElizaOS Capacitor builds — UA carries `ElizaOS/<tag>`
  //  - Stock Capacitor sideloads (Pixel 6a, Solana Seeker, Moto G,
  //    iOS test installs) — UA has no ElizaOS marker but still runs
  //    the bundled agent on 127.0.0.1:31337. Cold-boot is ~30s PGlite
  //    migration + ~30s agent registration before /api/auth/status
  //    binds, vs. <5s for cloud/remote backends.
  // Web / hosted-cloud builds keep the snappy 30s budget so a real
  // backend outage surfaces fast instead of staring at the splash.
  if (
    typeof navigator !== "undefined" &&
    /\bElizaOS\//.test(navigator.userAgent ?? "")
  ) {
    return 180_000;
  }
  if (isCapacitorNativePlatform()) {
    return 180_000;
  }
  return 30_000;
}
