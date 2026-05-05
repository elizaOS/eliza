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

export function getBackendStartupTimeoutMs(): number {
  if (isElectrobunRuntime()) return 180_000;
  // ElizaOS runs the on-device agent in the same APK; cold-boot is
  // ~30s PGlite migration + ~30s agent registration before the API is
  // reachable, vs. <5s for cloud/remote backends. Use the same 3-minute
  // budget as the desktop path so the splash poll loop catches it
  // instead of dead-ending on a "Backend Timeout" card.
  if (
    typeof navigator !== "undefined" &&
    /\bElizaOS\//.test(navigator.userAgent ?? "")
  ) {
    return 180_000;
  }
  return 30_000;
}
