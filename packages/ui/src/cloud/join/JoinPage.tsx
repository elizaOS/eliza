/**
 * Join page (`/join`) — the post-login landing that drops the user straight into
 * their agent (the headline migration outcome).
 *
 * After Steward login the user is redirected here. This page runs the join flow
 * (select-or-provision a Cloud agent, point the live client at it, persist the
 * `cloud:<agentId>` active server, mark first-run complete), shows a brief
 * progress state, then hard-navigates to `/` — the tab/view app, where chat is
 * home. A full navigation (not an in-router push) is deliberate: it lets the
 * app's startup coordinator boot fresh against the just-persisted cloud server.
 *
 * Signed-out app-host visitors first restore a live apex session through the
 * PKCE SSO bridge, or fall back to `/login?returnTo=/join` when no apex session
 * marker exists. This keeps the same URL safe for marketing and email links.
 *
 * Web-build-only (mounted by the cloud router shell); never loaded by the native
 * tab/view app directly.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { useCallback, useEffect, useRef, useState } from "react";
import { Navigate } from "react-router-dom";
import { client } from "../../api";
import { Button } from "../../components/ui/button";
import { getBootConfig } from "../../config/boot-config-store";
import {
  clearPersistedActiveServer,
  savePersistedActiveServer,
  savePersistedFirstRunComplete,
} from "../../state/persistence";
import { appModeNavigation } from "../app-mode/app-mode";
import { openCloudBillingConsole } from "../billing-console";
import { useCloudT } from "../shell/CloudI18nProvider";
import {
  clearSsoLoggedOut,
  redirectToSsoBridge,
  shouldAutoBridgeToSso,
} from "../sso-bridge/sso-bridge";
import { resolveApexJoinHandoff } from "./lib/apex-app-handoff";
import { describeJoinCreditGateError } from "./lib/join-credit-gate-error";
import {
  resolveJoinAuthToken,
  resolveJoinCloudApiBase,
} from "./lib/resolve-cloud-connection";
import { runJoinFlow } from "./lib/run-join-flow";
import { useJoinSessionAuth } from "./lib/use-join-session";

/** Default agent name when the user has none and we provision a fresh one. */
const DEFAULT_AGENT_NAME = "Eliza";
const DEFAULT_AGENT_BIO = ["An autonomous AI agent powered by elizaOS."];

type JoinPhase = "connecting" | "ready" | "error" | "credit-gate";

/** The last-active Cloud agent id, used as `preferAgentId` so a returning user
 * with several agents resumes the one they used last (not a guess). */
function readLastActiveCloudAgentId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem("elizaos:active-server");
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { kind?: string; id?: string };
    if (parsed.kind !== "cloud" || typeof parsed.id !== "string") return null;
    return parsed.id.startsWith("cloud:")
      ? parsed.id.slice("cloud:".length).trim() || null
      : null;
  } catch {
    // error-policy:J3 corrupt persisted server entry — no reusable agent id;
    // the join flow provisions from scratch.
    return null;
  }
}

function describeJoinError(err: unknown): string {
  if (err instanceof Error && err.message.trim()) return err.message;
  return "Could not connect to your agent. Try again.";
}

export default function JoinPage(): React.JSX.Element {
  const t = useCloudT();
  const session = useJoinSessionAuth();
  const [phase, setPhase] = useState<JoinPhase>("connecting");
  const [detail, setDetail] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [creditGateWithheldReason, setCreditGateWithheldReason] = useState<
    "ip_daily_cap" | "count_unavailable" | null
  >(null);
  const appHandoff =
    typeof window === "undefined"
      ? null
      : resolveApexJoinHandoff(window.location.hostname);
  const ssoDecisionRef = useRef(false);
  const [ssoBridging, setSsoBridging] = useState<boolean | null>(null);
  // Guard so React StrictMode's double-mount (and re-renders) don't double-run
  // the provisioning network calls.
  const startedRef = useRef(false);

  const start = useCallback(async () => {
    const authToken = resolveJoinAuthToken();
    if (!authToken) {
      // No session — the auth gate below redirects to login; bail quietly.
      return;
    }
    setPhase("connecting");
    setError(null);
    setCreditGateWithheldReason(null);
    try {
      const result = await runJoinFlow({
        client,
        effects: {
          savePersistedActiveServer,
          clearPersistedActiveServer,
          savePersistedFirstRunComplete,
        },
        cloudApiBase: resolveJoinCloudApiBase(),
        authToken,
        agentName: DEFAULT_AGENT_NAME,
        bio: DEFAULT_AGENT_BIO,
        preferAgentId: readLastActiveCloudAgentId(),
        preferSharedTier: getBootConfig().preferSharedCloudTier ?? undefined,
        onProgress: (_status, progressDetail) => {
          if (progressDetail) setDetail(progressDetail);
        },
      });
      setPhase("ready");
      // Hard navigation to chat home so the startup coordinator restores the
      // just-persisted cloud connection from a clean boot. `void result` keeps
      // the resolved agent in scope for future telemetry without unused-var noise.
      void result;
      if (typeof window !== "undefined") {
        appModeNavigation.assign("/");
      }
    } catch (err) {
      // The Cloud's credit gate (402) is a payment state, not a connection
      // failure: retry can never succeed, so render the server's explanation
      // (e.g. the welcome bonus withheld by the per-IP daily free-credit cap
      // — CGNAT networks) with an add-funds path instead of the dead-end
      // "Couldn't connect to your agent" + Retry.
      const creditGate = describeJoinCreditGateError(err);
      if (creditGate) {
        setError(creditGate.message);
        setCreditGateWithheldReason(
          creditGate.welcomeBonusWithheld
            ? (creditGate.welcomeBonusWithheldReason ?? "count_unavailable")
            : null,
        );
        setPhase("credit-gate");
        return;
      }
      setError(describeJoinError(err));
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    if (!session.ready) return;
    if (!session.authenticated) {
      if (ssoDecisionRef.current) return;
      ssoDecisionRef.current = true;
      if (!shouldAutoBridgeToSso()) {
        setSsoBridging(false);
        return;
      }
      void redirectToSsoBridge("/join").then((started) => {
        setSsoBridging(started);
      });
      return;
    }
    clearSsoLoggedOut();
    if (appHandoff) {
      // The apex is the billing console and cannot boot chat. Hand off before
      // any join/provisioning request. Preserve /join so the app host restores
      // the domain-wide session through the existing SSO bridge, then selects
      // or provisions the agent before opening chat.
      appModeNavigation.replace(appHandoff);
      return;
    }
    if (startedRef.current) return;
    startedRef.current = true;
    void start();
  }, [session.ready, session.authenticated, appHandoff, start]);

  const handleRetry = useCallback(() => {
    startedRef.current = true;
    void start();
  }, [start]);

  // Signed out → send to login, returning here once authenticated.
  if (session.ready && !session.authenticated && ssoBridging === false) {
    return <Navigate to="/login?returnTo=/join" replace />;
  }

  return (
    <div
      className="theme-cloud flex min-h-screen w-full flex-col items-center justify-center bg-black px-4 text-white"
      style={{ background: "var(--background)" }}
    >
      <div className="flex w-full max-w-sm flex-col items-center gap-6 text-center">
        <img
          src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
          alt="Eliza Cloud"
          className="h-8 w-auto"
          draggable={false}
        />

        {phase === "credit-gate" ? (
          <div
            className="flex flex-col items-center gap-4"
            data-testid="join-credit-gate"
          >
            <h1 className="font-poppins text-lg font-semibold text-white">
              {creditGateWithheldReason
                ? t("cloud.join.creditGateWithheldTitle", {
                    defaultValue: "Welcome credit unavailable",
                  })
                : t("cloud.join.creditGateTitle", {
                    defaultValue: "Add funds to start your agent",
                  })}
            </h1>
            <p className="text-sm text-white/70">
              {error ??
                t("cloud.join.creditGateBody", {
                  defaultValue: "Add funds to start an agent.",
                })}
            </p>
            {creditGateWithheldReason === "ip_daily_cap" ? (
              <p className="text-sm text-white/50">
                {t("cloud.join.creditGateWithheldHint", {
                  defaultValue:
                    "This limit is per network and resets daily. Your account itself is fine.",
                })}
              </p>
            ) : null}
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                void openCloudBillingConsole();
              }}
              className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
            >
              {t("cloud.join.creditGateCta", { defaultValue: "Add funds" })}
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={handleRetry}
              className="px-6 py-2 text-sm text-white/70 transition-colors hover:text-white"
            >
              {t("cloud.join.creditGateRecheck", {
                defaultValue: "I've added funds, try again",
              })}
            </Button>
          </div>
        ) : phase === "error" ? (
          <div className="flex flex-col items-center gap-4">
            <h1 className="font-poppins text-lg font-semibold text-white">
              {t("cloud.join.errorTitle", {
                defaultValue: "Couldn't connect to your agent",
              })}
            </h1>
            <p className="text-sm text-white/70">
              {error ??
                t("cloud.join.errorBody", {
                  defaultValue: "Something went wrong. Try again.",
                })}
            </p>
            <Button
              variant="ghost"
              type="button"
              onClick={handleRetry}
              className="bg-txt px-6 py-2.5 font-semibold text-bg transition-colors hover:bg-txt/90"
            >
              {t("cloud.join.retry", { defaultValue: "Try again" })}
            </Button>
          </div>
        ) : (
          <div
            className="flex flex-col items-center gap-4"
            role="status"
            aria-busy="true"
          >
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
            <p className="text-sm text-white/72">
              {detail ||
                t("cloud.join.connecting", {
                  defaultValue: "Connecting you to your agent...",
                })}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
