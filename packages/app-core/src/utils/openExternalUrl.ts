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
  // The RPC may be missing because the preload hasn't wired yet or the
  // specific method isn't registered; either way opening a raw popup is worse.
  if (getElectrobunRendererRpc() !== undefined) {
    console.warn(
      "[openExternalUrl] desktopOpenExternal RPC returned null — skipping window.open fallback",
    );
    return;
  }

  // Non-desktop (web browser) fallback — never throw on popup block.
  // OAuth flows call this after async gaps which lose user-gesture context,
  // so popup blocking is expected. Callers handle the fallback (e.g. showing
  // the URL for manual copy-paste) and continue polling.
  if (typeof window === "undefined" || typeof window.open !== "function") {
    console.warn("[openExternalUrl] window.open unavailable — URL:", url);
    return;
  }

  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) {
    console.warn("[openExternalUrl] popup blocked — URL:", url);
  }
}
