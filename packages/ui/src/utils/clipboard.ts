import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

function copyWithLegacyDomApi(text: string): boolean {
  if (typeof document === "undefined") return false;

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  textarea.style.pointerEvents = "none";
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const bridged = await invokeDesktopBridgeRequest<void>({
    rpcMethod: "desktopWriteToClipboard",
    ipcChannel: "desktop:writeToClipboard",
    params: { text },
  });

  if (bridged !== null) return;

  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (copyWithLegacyDomApi(text)) return;

  throw new Error("Clipboard API unavailable.");
}
