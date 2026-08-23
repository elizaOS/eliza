/**
 * Open the Agent Web UI for a hosted (dedicated) agent via the pairing-token
 * flow.
 *
 * 1. Opens a popup immediately (must be in a click handler to dodge blockers).
 * 2. Polls `POST /api/v1/eliza/agents/:id/pairing-token` for a one-time token
 *    (202 + Retry-After while the agent boots).
 * 3. Redirects the popup to the agent's `/pair` page, which exchanges the token
 *    server-side and pins the agent's API key on the SPA's
 *    boot config before redirecting to `/`.
 */

import { toast } from "sonner";
import { apiWithStatus } from "../../lib/api-client";
import { isSafeNavigationUrl } from "../../lib/navigation-url";

const MAX_PAIRING_WAIT_MS = 120_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;

interface PairingTokenResponse {
  data?: {
    redirectUrl?: string;
    retryAfterMs?: number;
    status?: string;
    message?: string;
  };
  error?: string;
}

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

function retryAfterMs(data: PairingTokenResponse): number {
  const fromBody = data.data?.retryAfterMs;
  if (typeof fromBody === "number" && fromBody > 0) return fromBody;
  return DEFAULT_RETRY_AFTER_MS;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function openWebUIWithPairing(agentId: string): Promise<void> {
  const popup = window.open("", "_blank");
  if (!popup) {
    toast.error("Popup blocked. Please allow popups and try again.");
    return;
  }

  try {
    setPopupMessage(popup, "Connecting to your agent…");

    const deadline = Date.now() + MAX_PAIRING_WAIT_MS;
    while (Date.now() < deadline) {
      const { status, data } = await apiWithStatus<PairingTokenResponse>(
        `/api/v1/eliza/agents/${agentId}/pairing-token`,
        { method: "POST" },
      );

      if (popup.closed) return;

      if (status === 202) {
        const message =
          data.data?.message ??
          "Agent is starting. Connecting when the Web UI is ready…";
        setPopupMessage(popup, message);
        await sleep(retryAfterMs(data));
        continue;
      }

      if (status < 200 || status >= 300) {
        popup.close();
        toast.error(
          data.error || `Failed to generate pairing token (HTTP ${status})`,
        );
        return;
      }

      if (data.data?.redirectUrl) {
        if (!isSafeNavigationUrl(data.data.redirectUrl)) {
          // The redirect URL is a wire value assigned to the popup's top
          // window — only absolute http(s) may navigate.
          popup.close();
          toast.error("Pairing redirect URL is not a valid URL");
          return;
        }
        popup.location.href = data.data.redirectUrl;
        return;
      }

      popup.close();
      toast.error("No redirect URL returned from pairing token endpoint");
      return;
    }

    popup.close();
    toast.error("Agent Web UI did not become ready in time. Try again.");
  } catch (err) {
    popup.close();
    toast.error(
      `Failed to connect: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
