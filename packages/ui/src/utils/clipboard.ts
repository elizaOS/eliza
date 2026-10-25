/**
 * Cross-platform clipboard write: prefers the desktop bridge, then the async
 * Clipboard API, falling back to a legacy execCommand path for older webviews.
 */
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
    // error-policy:J4 legacy path failure reads as "copy failed" — the caller
    // chain reports the boolean and surfaces its own failure UI.
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
    // error-policy:J4 the async API existing does NOT mean the write succeeds:
    // permissions policy, a non-focused document, or a headless harness reject
    // the call at write time. That is a per-call denial, not "no clipboard" —
    // treat it as this rung failing and fall through to the legacy execCommand
    // path (which works in exactly those environments); only when every rung
    // fails does the caller see the throw below.
    const wrote = await navigator.clipboard.writeText(text).then(
      () => true,
      () => false,
    );
    if (wrote) return;
  }

  if (copyWithLegacyDomApi(text)) return;

  throw new Error("Clipboard API unavailable.");
}
