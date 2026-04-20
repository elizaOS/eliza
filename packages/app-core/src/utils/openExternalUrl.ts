import {
  getElectrobunRendererRpc,
  invokeDesktopBridgeRequestWithTimeout,
} from "../bridge/electrobun-rpc";

export async function openExternalUrl(url: string): Promise<void> {
  const bridged = await invokeDesktopBridgeRequestWithTimeout<void>({
    rpcMethod: "desktopOpenExternal",
    ipcChannel: "desktop:openExternal",
    params: { url },
    timeoutMs: 10_000,
  });

  if (bridged !== null && bridged.status === "ok") return;

  // Inside Electrobun — never fall through to window.open() which spawns an
  // unmanaged BrowserView to an external URL and crashes the shell.
  if (getElectrobunRendererRpc() !== undefined) {
    console.warn(
      "[openExternalUrl] desktopOpenExternal RPC returned null — skipping window.open fallback",
    );
    return;
  }

  // Non-desktop (web browser) fallback.
  if (typeof window === "undefined" || typeof window.open !== "function") {
    console.warn("[openExternalUrl] window.open unavailable — URL:", url);
    return;
  }

  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) {
    console.warn("[openExternalUrl] popup blocked — URL:", url);
  }
}

/**
 * Pre-open a blank window **synchronously** inside a user-gesture handler,
 * then navigate it after an async API call resolves with the real URL.
 * This avoids popup-blocker issues that occur when `window.open` is called
 * after an `await` (losing the user-gesture context).
 *
 * Usage:
 * ```ts
 * const win = preOpenWindow();
 * const { authUrl } = await client.startLogin();
 * navigatePreOpenedWindow(win, authUrl);
 * ```
 */
export function preOpenWindow(): Window | null {
  if (getElectrobunRendererRpc() !== undefined) return null; // Desktop uses RPC
  if (typeof window === "undefined" || typeof window.open !== "function")
    return null;
  // Open a blank window synchronously (preserves user-gesture context).
  // No noopener (nullifies return value) or noreferrer (can make about:blank cross-origin).
  return window.open("about:blank", "_blank");
}

/**
 * Navigate a pre-opened window to the real URL, or fall back to
 * `openExternalUrl` if the pre-open was blocked / we're on desktop.
 */
export function navigatePreOpenedWindow(
  popup: Window | null,
  url: string,
): void {
  if (popup && !popup.closed) {
    popup.location.href = url;
    // Security: sever the opener reference now that navigation is done.
    try {
      popup.opener = null;
    } catch {
      /* cross-origin — fine */
    }
    return;
  }
  // Fallback — desktop RPC or retry window.open
  void openExternalUrl(url);
}
