"use client";

import { toast } from "sonner";

/**
 * Opens the Agent Web UI for an agent via the pairing token flow.
 *
 * 1. Opens a popup immediately (must be in click handler to avoid popup blockers)
 * 2. Fetches a one-time pairing token from the dashboard API
 * 3. Redirects the popup to the agent's /pair page with the token
 * 4. pair.html exchanges the token for an API key and stores it
 */
export async function openWebUIWithPairing(agentId: string): Promise<void> {
  const popup = window.open("", "_blank");
  if (!popup) {
    toast.error("Popup blocked. Please allow popups and try again.");
    return;
  }

  try {
    popup.document.title = "Connecting…";
    popup.document.body.innerHTML =
      '<div style="font-family:sans-serif;padding:20px;background:#0a0a0a;color:#e5e5e5;min-height:100vh;display:flex;align-items:center;justify-content:center">Connecting to your agent…</div>';
  } catch {
    // cross-origin write may fail
  }

  try {
    const res = await fetch(`/api/v1/eliza/agents/${agentId}/pairing-token`, {
      method: "POST",
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({ error: "Unknown error" }));
      popup.close();
      toast.error(data.error || `Failed to generate pairing token (HTTP ${res.status})`);
      return;
    }

    const { data } = await res.json();
    if (popup.closed) {
      // User closed the popup before the fetch completed — nothing to do
      return;
    }
    if (data?.redirectUrl) {
      popup.location.href = data.redirectUrl;
    } else {
      popup.close();
      toast.error("No redirect URL returned from pairing token endpoint");
    }
  } catch (err) {
    popup.close();
    toast.error(`Failed to connect: ${err instanceof Error ? err.message : String(err)}`);
  }
}
