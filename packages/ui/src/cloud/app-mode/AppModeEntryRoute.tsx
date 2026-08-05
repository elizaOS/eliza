/**
 * App-mode entry gate for the Eliza app hosts (app.elizacloud.ai). Rendered by
 * the cloud router shell's catch-all INSTEAD of the tab/view app whenever
 * `isAppModeHost()` is true, so it owns every non-registered path on the app
 * hosts; registered cloud routes (login / auth / dashboard / payment / join)
 * match before the catch-all and stay reachable.
 *
 * After the existing Steward session auth resolves, the gate fetches the org's
 * agents and routes per `decideAppModeRoute`: one running dedicated agent →
 * full-page pairing redirect into its web UI (202 "must resume" and pairing
 * failures degrade to the Instances console); several → a minimal chooser;
 * dedicated-but-stopped → Instances; shared-tier-only orgs fall through to the
 * same-origin chat app unchanged; no agents at all → the `/join`
 * deploy-first-agent flow. Unauthenticated visitors first get one shot at the
 * cross-host SSO bridge (`../sso-bridge/sso-bridge` — only when the
 * domain-wide session marker says the dashboard pair holds a live session and
 * the user did not explicitly sign out here), then the normal login flow, and
 * return here. None of this mounts on apex control-plane hosts — the shell's
 * apex branch runs first — so the apex console never issues app-mode network
 * calls.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button } from "../../components/ui/button";
import { useAgents } from "../instances/lib/data/eliza-agents";
import { useSessionAuth } from "../lib/use-session-auth";
import {
  clearSsoLoggedOut,
  redirectToSsoBridge,
  shouldAutoBridgeToSso,
} from "../sso-bridge/sso-bridge";
import {
  APP_MODE_INSTANCES_PATH,
  type AppModeAgent,
  decideAppModeRoute,
  redirectToAgentWebUI,
} from "./app-mode";

function EntryNotice({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="theme-cloud flex min-h-dvh flex-col items-center justify-center gap-4 bg-black px-6 text-center text-white">
      <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/62">
        {label}
      </p>
      {children}
    </div>
  );
}

export function AppModeEntryRoute({
  appElement,
}: {
  appElement: ReactNode;
}): React.JSX.Element {
  const { ready, authenticated } = useSessionAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const agentsQuery = useAgents();

  const redirectStartedRef = useRef(false);
  const [redirectError, setRedirectError] = useState<string | null>(null);

  // Unauthenticated visits may ride the cross-host SSO bridge instead of the
  // local login: when the domain-wide session marker says the dashboard pair
  // holds a live session (and the user did not explicitly sign out here), the
  // effect performs the full-page bounce to the dashboard mint leg. The
  // decision runs in an effect — never during render — because it reads
  // cookies/storage/clock, and it is single-shot per mount.
  const ssoDecisionRef = useRef(false);
  const [ssoBridging, setSsoBridging] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (authenticated) {
      // Any live sign-in on this origin re-arms auto-bridging for the future
      // (the logged-out marker's job ends at the next real login).
      clearSsoLoggedOut();
      return;
    }
    if (ssoDecisionRef.current) return;
    ssoDecisionRef.current = true;
    if (
      shouldAutoBridgeToSso() &&
      redirectToSsoBridge(`${location.pathname}${location.search}`)
    ) {
      setSsoBridging(true);
      return;
    }
    setSsoBridging(false);
  }, [ready, authenticated, location]);

  const route =
    authenticated && agentsQuery.data !== undefined
      ? decideAppModeRoute(agentsQuery.data)
      : null;
  const entryAgent = route?.kind === "enter-agent" ? route.agent : null;

  // Exactly one running dedicated agent → full-page redirect into its web UI.
  // The ref makes the pairing POST once-per-mount: the agents query repolls and
  // re-derives `route`, and a second POST would burn another one-time token.
  useEffect(() => {
    if (!entryAgent || redirectStartedRef.current) return;
    redirectStartedRef.current = true;
    void redirectToAgentWebUI(entryAgent.id).then((result) => {
      if (result.ok) return;
      if (result.starting) {
        // 202 — the server queued a resume; land on Instances where the agent's
        // status and wake progress are visible.
        navigate(APP_MODE_INSTANCES_PATH, { replace: true });
        return;
      }
      setRedirectError(result.error);
    });
  }, [entryAgent, navigate]);

  if (!ready) {
    return <EntryNotice label="Loading" />;
  }

  if (!authenticated) {
    if (ssoBridging !== false) {
      // Decision pending (first paint before the effect) or the full-page
      // bounce to the dashboard mint leg is in flight — hold a notice, never
      // flash the login page under a navigation that is already leaving.
      return <EntryNotice label="Signing you in" />;
    }
    // The existing login flow; returnTo brings the user back to this entry,
    // which re-runs with a session.
    const returnTo = encodeURIComponent(
      `${location.pathname}${location.search}`,
    );
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }

  if (agentsQuery.isError) {
    // Never a blank screen: the Instances console owns the failure surface
    // (skeleton / error state / retry) for the same list.
    return <Navigate to={APP_MODE_INSTANCES_PATH} replace />;
  }

  if (!route) {
    return <EntryNotice label="Loading your agent" />;
  }

  switch (route.kind) {
    case "enter-agent":
      if (redirectError) {
        return (
          <EntryNotice label="Connection failed">
            <p className="max-w-sm text-sm text-white/62">{redirectError}</p>
            <Button
              type="button"
              variant="outline"
              onClick={() => navigate(APP_MODE_INSTANCES_PATH)}
            >
              Go to your instances
            </Button>
          </EntryNotice>
        );
      }
      return <EntryNotice label="Connecting to your agent" />;

    case "choose-agent":
      return <AgentChooser running={route.running} />;

    case "resume":
    case "create":
      return <Navigate to={route.to} replace />;

    case "chat-home":
      return <>{appElement}</>;
  }
}

/** Minimal chooser for orgs with several running dedicated agents; each row
 * deep-links through the same pairing redirect as automatic entry. */
function AgentChooser({
  running,
}: {
  running: AppModeAgent[];
}): React.JSX.Element {
  const navigate = useNavigate();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function openAgent(agentId: string): Promise<void> {
    setPendingId(agentId);
    setError(null);
    const result = await redirectToAgentWebUI(agentId, "user-initiated");
    if (!result.ok) {
      setPendingId(null);
      setError(
        result.starting
          ? "Agent is still starting — try again shortly."
          : result.error,
      );
    }
  }

  return (
    <EntryNotice label="Pick your agent">
      <div className="w-full max-w-sm space-y-2 text-left">
        {running.map((agent) => (
          <button
            key={agent.id}
            type="button"
            disabled={pendingId !== null}
            onClick={() => void openAgent(agent.id)}
            className="flex w-full items-center justify-between border border-white/15 bg-white/5 px-4 py-3 text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            <span className="truncate">{agent.agentName ?? agent.id}</span>
            <span className="ml-3 shrink-0 font-mono text-[11px] uppercase tracking-widest text-white/62">
              {pendingId === agent.id ? "Connecting…" : "Open"}
            </span>
          </button>
        ))}
      </div>
      {error ? <p className="max-w-sm text-sm text-red-400">{error}</p> : null}
      <Button
        type="button"
        variant="link"
        className="text-xs text-white/62"
        onClick={() => navigate(APP_MODE_INSTANCES_PATH)}
      >
        Manage all instances
      </Button>
    </EntryNotice>
  );
}

export default AppModeEntryRoute;
