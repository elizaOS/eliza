import { openExternalUrl } from "@elizaos/ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { vincentClient } from "./client";

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

  const pollVincentStatus = useCallback(async () => {
    try {
      const status = await vincentClient.vincentStatus();
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

  const handleVincentLogin = useCallback(async () => {
    if (vincentConnected || busyRef.current || vincentLoginBusy) return;
    busyRef.current = true;
    setVincentLoginBusy(true);
    setVincentLoginError(null);

    try {
      const { authUrl } = await vincentClient.vincentStartLogin("Eliza");
      await openExternalUrl(authUrl);

      if (loginPollRef.current) clearInterval(loginPollRef.current);
      let pollAttempts = 0;
      const maxPollAttempts = 24;
      loginPollRef.current = setInterval(async () => {
        pollAttempts++;
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
  }, [
    pollVincentStatus,
    setActionNotice,
    t,
    vincentConnected,
    vincentLoginBusy,
  ]);

  const handleVincentDisconnect = useCallback(async () => {
    try {
        await vincentClient.vincentDisconnect();
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
