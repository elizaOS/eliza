/**
 * Vincent OAuth state — manages connect/disconnect flow for the wallet UI.
 *
 * Flow:
 * - Call POST /api/vincent/start-login → server generates PKCE and returns authUrl
 * - Open authUrl in the user's external browser
 * - Vincent redirects to GET /callback/vincent on the same API origin,
 *   which exchanges the code server-side and persists tokens
 * - This hook polls /api/vincent/status and flips to connected when the
 *   server-side exchange completes
 */

import { client, openExternalUrl } from "@elizaos/app-core";
import { useCallback, useEffect, useRef, useState } from "react";

interface VincentStateParams {
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
  t: (key: string, opts?: Record<string, unknown>) => string;
}

export function useVincentState({ setActionNotice, t }: VincentStateParams) {
  const [vincentConnected, setVincentConnected] = useState(false);
  const [vincentLoginBusy, setVincentLoginBusy] = useState(false);
  const [vincentLoginError, setVincentLoginError] = useState<string | null>(
    null,
  );
  const [vincentConnectedAt, setVincentConnectedAt] = useState<number | null>(
    null,
  );
  const busyRef = useRef(false);
  const loginPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // ── Poll status on mount ────────────────────────────────────────
  const pollVincentStatus = useCallback(async () => {
    try {
      const status = await client.vincentStatus();
      setVincentConnected(status.connected);
      setVincentConnectedAt(status.connectedAt);
      return status.connected;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    void pollVincentStatus();
    return () => {
      if (loginPollRef.current) {
        clearInterval(loginPollRef.current);
        loginPollRef.current = null;
      }
    };
  }, [pollVincentStatus]);

  // ── Login flow ──────────────────────────────────────────────────
  // The browser tab that Vincent redirects back to lands on GET
  // /callback/vincent on the app API origin, which does the token
  // exchange server-side.  All this hook does is kick off that flow and
  // poll /api/vincent/status until it flips to connected.
  const handleVincentLogin = useCallback(async () => {
    if (vincentConnected || busyRef.current || vincentLoginBusy) return;
    busyRef.current = true;
    setVincentLoginBusy(true);
    setVincentLoginError(null);

    try {
      // Step 1: Ask server to generate PKCE + authUrl
      const { authUrl } = await client.vincentStartLogin("Eliza");

      // Step 2: Open the browser on the authUrl
      await openExternalUrl(authUrl);

      // Step 3: Poll /api/vincent/status until the server-side callback
      // completes the token exchange. Also acts as a fallback if the user
      // closes the auth window.
      if (loginPollRef.current) clearInterval(loginPollRef.current);
      let pollAttempts = 0;
      const maxPollAttempts = 24; // ~2 minutes at 5s intervals
      loginPollRef.current = setInterval(async () => {
        pollAttempts++;
        try {
          const connected = await pollVincentStatus();
          if (connected) {
            if (loginPollRef.current) clearInterval(loginPollRef.current);
            loginPollRef.current = null;
            setVincentLoginBusy(false);
            busyRef.current = false;
            setVincentLoginError(null);
            setActionNotice(
              t("vincent.connected", { defaultValue: "Vincent connected" }),
              "success",
              5000,
            );
            return;
          }
        } catch {
          // ignore poll errors
        }
        if (pollAttempts >= maxPollAttempts) {
          if (loginPollRef.current) clearInterval(loginPollRef.current);
          loginPollRef.current = null;
          setVincentLoginBusy(false);
          busyRef.current = false;
          setVincentLoginError(
            t("vincent.loginTimeout", {
              defaultValue:
                "Login timed out. Close the auth window and try again.",
            }),
          );
        }
      }, 5000);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Vincent login failed";
      setVincentLoginError(msg);
      setVincentLoginBusy(false);
      busyRef.current = false;
    }
  }, [vincentConnected, vincentLoginBusy]);

  // ── Disconnect ──────────────────────────────────────────────────
  const handleVincentDisconnect = useCallback(async () => {
    try {
      await client.vincentDisconnect();
      setVincentConnected(false);
      setVincentConnectedAt(null);
      setVincentLoginError(null);
      setActionNotice(
        t("vincent.disconnected", { defaultValue: "Vincent disconnected" }),
        "info",
        3000,
      );
    } catch (err) {
      setVincentLoginError(
        err instanceof Error ? err.message : "Disconnect failed",
      );
    }
  }, [setActionNotice, t]);

  return {
    vincentConnected,
    vincentLoginBusy,
    vincentLoginError,
    vincentConnectedAt,
    handleVincentLogin,
    handleVincentDisconnect,
    pollVincentStatus,
  };
}
