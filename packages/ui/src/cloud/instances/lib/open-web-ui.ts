/**
 * Open the Agent Web UI for a hosted (dedicated) agent via the pairing-token
 * flow.
 *
 * 1. Opens a popup immediately (must be in a click handler to dodge blockers).
 * 2. Polls `POST /api/v1/eliza/agents/:id/pairing-token` for a one-time token
 *    (202 + Retry-After while the agent boots) via the shared
 *    `pollPairingTokenRedirectUrl` loop.
 * 3. Redirects the popup to the agent's `/pair` page, which exchanges the token
 *    server-side and pins the agent's API key on the SPA's
 *    boot config before redirecting to `/`.
 */

import { toast } from "sonner";
import { pollPairingTokenRedirectUrl } from "../../pairing-token-poll";

const MAX_PAIRING_WAIT_MS = 120_000;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setPopupMessage(popup: Window, message: string) {
  try {
    popup.document.title = "Connecting…";
    popup.document.body.innerHTML = `<div style="font-family:sans-serif;padding:20px;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;align-items:center;justify-content:center">${escapeHtml(message)}</div>`;
  } catch {
    // cross-origin write may fail
  }
}

export async function openWebUIWithPairing(agentId: string): Promise<void> {
  const popup = window.open("", "_blank");
  if (!popup) {
    toast.error("Popup blocked. Please allow popups and try again.");
    return;
  }

  try {
    setPopupMessage(popup, "Connecting to your agent…");

    const result = await pollPairingTokenRedirectUrl({
      agentId,
      maxWaitMs: MAX_PAIRING_WAIT_MS,
      onStarting: (message) => setPopupMessage(popup, message),
      shouldAbort: () => popup.closed,
    });

    if (result.ok) {
      popup.location.href = result.redirectUrl;
      return;
    }

    // The user closing the popup is a cancel, not a failure — no toast.
    if (result.reason === "aborted") return;

    popup.close();
    if (result.reason === "request_failed") {
      toast.error(
        result.message ||
          `Failed to generate pairing token (HTTP ${result.status})`,
      );
      return;
    }
    if (result.reason === "no_redirect_url") {
      toast.error("No redirect URL returned from pairing token endpoint");
      return;
    }
    toast.error("Agent Web UI did not become ready in time. Try again.");
  } catch (err) {
    // error-policy:J1 click-handler boundary — a network-level mint failure
    // surfaces as a visible toast instead of an unhandled rejection.
    popup.close();
    toast.error(
      `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
