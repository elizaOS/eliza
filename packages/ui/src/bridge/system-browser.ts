/** Opens browser-workspace websites in the full Chromium profile on Linux. */
import { openExternalUrl } from "../utils";
import { invokeDesktopBridgeRequest } from "./electrobun-rpc";
import { isElectrobunRuntime } from "./electrobun-runtime";

export function usesOwnedChromiumBrowser(): boolean {
  return (
    isElectrobunRuntime() &&
    typeof navigator !== "undefined" &&
    /linux/i.test(navigator.platform)
  );
}

export async function openBrowserWebsite(url: string): Promise<void> {
  if (usesOwnedChromiumBrowser()) {
    const receipt = await invokeDesktopBridgeRequest<{
      engine: "chromium";
      surface: "window";
    }>({
      rpcMethod: "desktopOpenBrowser",
      ipcChannel: "desktop:openBrowser",
      params: { url },
    });
    if (receipt?.engine !== "chromium" || receipt.surface !== "window") {
      throw new Error(
        "Chromium could not be opened. Update the desktop app and try again.",
      );
    }
    return;
  }
  await openExternalUrl(url);
}
