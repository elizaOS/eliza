import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

export async function openExternalUrl(url: string): Promise<void> {
  const bridged = await invokeDesktopBridgeRequest<void>({
    rpcMethod: "desktopOpenExternal",
    ipcChannel: "desktop:openExternal",
    params: { url },
  });

  if (bridged !== null) return;

  if (typeof window === "undefined" || typeof window.open !== "function") {
    throw new Error("Popup blocked. Allow popups and try again.");
  }

  const popup = window.open(url, "_blank", "noopener,noreferrer");
  if (!popup) {
    throw new Error("Popup blocked. Allow popups and try again.");
  }
}
