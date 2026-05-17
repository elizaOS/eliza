/**
 * Copy text to the clipboard in browsers. Tries the Clipboard API first (requires secure context),
 * then `document.execCommand('copy')` for plain HTTP or older browsers.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") {
    return false;
  }

  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to execCommand */
  }

  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === "undefined") {
    return false;
  }
  if (!document.body) {
    return false;
  }

  const node = document.createElement("textarea");
  node.value = text;
  node.setAttribute("readonly", "");
  node.style.position = "fixed";
  node.style.left = "-9999px";
  document.body.appendChild(node);
  node.select();

  const ok = document.execCommand("copy");
  document.body.removeChild(node);
  return ok;
}
