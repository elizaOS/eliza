/** Resolve localhost CLI credentials through the real Cloud account authority. */
import { ELIZA_DOMAIN_CONTRACTS } from "@elizaos/shared/elizacloud";
import {
  readStoredStewardToken,
  STEWARD_SESSION_CHANGE_EVENT,
} from "@elizaos/shared/steward-session-client";
import { useEffect, useState } from "react";
import { isLoopbackStagingStewardDevelopment } from "../../state/loopback-steward-development";
import { normalizeCloudApiKeyToken } from "../lib/cloud-api-key-token";

/** CLI keys are not JWTs; only the explicitly configured loopback lane uses them here. */
export function loopbackCliToken(): string | null {
  return isLoopbackStagingStewardDevelopment()
    ? normalizeCloudApiKeyToken(readStoredStewardToken())
    : null;
}

type CliSession = {
  loading: boolean;
  token: string | null;
  user: { id: string; email: string } | null;
};

/** A key-shaped string never opens account pages until the server accepts it. */
export function useLoopbackCliSession(): CliSession {
  const [session, setSession] = useState<CliSession>(() => ({
    loading: Boolean(loopbackCliToken()),
    token: null,
    user: null,
  }));
  useEffect(() => {
    let active = true;
    let pending: AbortController | undefined;
    let observedToken: string | null | undefined;
    const verify = async () => {
      const token = loopbackCliToken();
      if (token === observedToken) return;
      observedToken = token;
      pending?.abort();
      if (!token) {
        setSession({ loading: false, token: null, user: null });
        return;
      }
      const controller = new AbortController();
      pending = controller;
      setSession({ loading: true, token: null, user: null });
      const timeout = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const apiBase = ELIZA_DOMAIN_CONTRACTS.staging.cloudApiOrigin;
        const response = await fetch(`${apiBase}/api/v1/user`, {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
          },
          credentials: "omit",
          signal: controller.signal,
        });
        if (
          !active ||
          controller.signal.aborted ||
          pending !== controller ||
          loopbackCliToken() !== token
        )
          return;
        if (response.status === 401 || response.status === 403) {
          throw new Error("Cloud account credential was rejected");
        }
        if (!response.ok) throw new Error("Cloud account verification failed");
        const body = await response.json();
        const user = body?.data ?? body;
        if (typeof user?.id !== "string" || !user.id.trim()) {
          throw new Error("Cloud account identity is missing");
        }
        if (
          active &&
          !controller.signal.aborted &&
          pending === controller &&
          loopbackCliToken() === token
        ) {
          setSession({
            loading: false,
            token,
            user: {
              id: user.id,
              email: typeof user.email === "string" ? user.email : "",
            },
          });
        }
      } catch {
        // error-policy:J4 network/invalid identity stays signed out; normal sign-in remains retryable.
        if (active && pending === controller) {
          setSession({ loading: false, token: null, user: null });
        }
      } finally {
        window.clearTimeout(timeout);
        if (active && pending === controller) {
          setSession((value) =>
            value.loading ? { loading: false, token: null, user: null } : value,
          );
        }
      }
    };
    const refresh = () => {
      void verify();
    };
    const revalidate = () => {
      observedToken = undefined;
      refresh();
    };
    refresh();
    window.addEventListener("storage", refresh);
    window.addEventListener(STEWARD_SESSION_CHANGE_EVENT, refresh);
    window.addEventListener("steward-token-sync", refresh);
    window.addEventListener("steward-unauthorized", revalidate);
    window.addEventListener("online", revalidate);
    return () => {
      active = false;
      pending?.abort();
      window.removeEventListener("storage", refresh);
      window.removeEventListener(STEWARD_SESSION_CHANGE_EVENT, refresh);
      window.removeEventListener("steward-token-sync", refresh);
      window.removeEventListener("steward-unauthorized", revalidate);
      window.removeEventListener("online", revalidate);
    };
  }, []);
  return session;
}
