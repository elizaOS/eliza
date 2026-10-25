/**
 * Clipboard + copy-feedback + referral-invite-link helpers for the monetization
 * surfaces. Kept local because `@elizaos/ui` does not depend on the
 * cloud-shared server bundle.
 */

import { useCallback, useState } from "react";

/**
 * Copy text to the clipboard. Tries the async Clipboard API first (requires a
 * secure context), then falls back to `document.execCommand('copy')` for plain
 * HTTP or older browsers.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (typeof window === "undefined") return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to execCommand
  }
  return copyViaExecCommand(text);
}

function copyViaExecCommand(text: string): boolean {
  if (typeof document === "undefined" || !document.body) return false;
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

/** Build the login URL used for referral attribution (`ref` query param). */
export function buildReferralInviteLoginUrl(
  origin: string,
  code: string,
): string {
  const base = origin.replace(/\/$/, "");
  return `${base}/login?ref=${encodeURIComponent(code)}`;
}

/** Transient "copied" feedback flag with auto-reset. */
export function useCopyFeedback(timeoutMs = 2000) {
  const [copied, setCopied] = useState(false);
  const markCopied = useCallback(() => {
    setCopied(true);
    window.setTimeout(() => setCopied(false), timeoutMs);
  }, [timeoutMs]);
  return { copied, markCopied };
}
