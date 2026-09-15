/**
 * App-mode entry gate for the Eliza app hosts (cloud.eliza.app). Rendered by
 * the cloud router shell's catch-all INSTEAD of the tab/view app whenever
 * `isAppModeHost()` is true, so it owns every non-registered path on the app
 * hosts; registered Cloud routes (login / auth / management / payment / join)
 * match before the catch-all and stay reachable.
 *
 * After the existing Steward session auth resolves, the gate fetches the org's
 * agents and routes per `decideAppModeRoute`: any agents → the same-origin
 * chat app (the chat floor — entry never pairing-redirects into a per-agent
 * web UI and never bounces to the console; see `./app-mode` for why the
 * entry-time pairing redirect was removed); no rows at all → the account's
 * rowless personal Eliza is resolved and bound in place (`./use-personal-entry`),
 * falling back to `/join` only when that identity cannot be resolved.
 * Unauthenticated visitors first get one shot at the
 * cross-host SSO bridge (`../sso-bridge/sso-bridge` — only when the
 * domain-wide session marker says the eliza.app auth origin holds a live session and
 * the user did not explicitly sign out here), then the normal login flow, and
 * return here. None of this mounts on apex control-plane hosts — the shell's
 * apex branch runs first — so the apex console never issues app-mode network
 * calls.
 */

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { loadPersistedActiveServer } from "../../state/persistence";
import { useAgents } from "../instances/lib/data/eliza-agents";
import { useSessionAuth } from "../lib/use-session-auth";
import {
  redirectToSsoBridge,
  shouldAutoBridgeToSso,
} from "../sso-bridge/sso-bridge";
import { decideAppModeRoute } from "./app-mode";
import { usePersonalEntry } from "./use-personal-entry";

function EntryNotice({
  label,
  children,
}: {
  label: string;
  children?: ReactNode;
}): React.JSX.Element {
  return (
    <div className="theme-cloud flex min-h-dvh flex-col items-center justify-center gap-4 bg-black px-6 text-center text-white">
      <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-white/62">
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
}): ReactNode {
  const { ready, authenticated } = useSessionAuth();
  const location = useLocation();
  const agentsQuery = useAgents();
  const isCloudManagementPath =
    location.pathname === "/cloud" || location.pathname.startsWith("/cloud/");

  // Rowless personal entry: with zero sandbox rows the personal Eliza is the
  // account's runtime, so entry resolves + persists its authoritative binding
  // instead of bouncing to /join (the /join → / → /join loop this fixes).
  const rowlessEntry =
    ready &&
    authenticated &&
    !isCloudManagementPath &&
    agentsQuery.data !== undefined &&
    agentsQuery.data.length === 0;
  const personalEntry = usePersonalEntry(rowlessEntry);

  // Unauthenticated visits may ride the cross-host SSO bridge instead of the
  // local login: when the domain-wide session marker says the auth origin
  // holds a live session (and the user did not explicitly sign out here), the
  // effect performs the full-page bounce to the eliza.app mint leg. The
  // decision runs in an effect — never during render — because it reads
  // cookies/storage/clock, and it is single-shot per mount.
  const ssoDecisionRef = useRef(false);
  const [ssoBridging, setSsoBridging] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ready) return;
    if (authenticated) return;
    if (ssoDecisionRef.current) return;
    ssoDecisionRef.current = true;
    if (!shouldAutoBridgeToSso()) {
      setSsoBridging(false);
      return;
    }
    // Async because the handshake hashes the PKCE verifier before leaving;
    // `ssoBridging` stays null (holding the notice) until it resolves.
    void redirectToSsoBridge(`${location.pathname}${location.search}`).then(
      (started) => setSsoBridging(started),
    );
  }, [ready, authenticated, location]);

  if (!ready) {
    return <EntryNotice label="Loading" />;
  }

  if (!authenticated) {
    if (ssoBridging !== false) {
      // Decision pending (first paint before the effect) or the full-page
      // bounce to the auth-origin mint leg is in flight — hold a notice, never
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

  // The Cloud route registry is mounted inside appElement. Do not wait for the
  // app-mode agents query before mounting it on a management URL: doing so
  // deadlocks private-route registration and leaves authenticated users on
  // "Loading your agent" when the query is slow or a stale agent credential
  // is being repaired. Management surfaces own their loading/error states.
  if (isCloudManagementPath) {
    return <>{appElement}</>;
  }

  if (agentsQuery.isError) {
    // Ordinary entry can only boot chat when a Cloud binding already identifies
    // the runtime; otherwise /join retries selection instead of starting an
    // unbound agent shell.
    return loadPersistedActiveServer()?.kind === "cloud" ? (
      appElement
    ) : (
      <Navigate to="/join" replace />
    );
  }

  if (agentsQuery.data === undefined) {
    return <EntryNotice label="Loading your agent" />;
  }

  const route = decideAppModeRoute(agentsQuery.data);
  // Account/billing/admin management remains reachable before an org creates
  // its first agent. With sandbox rows, ordinary product entry needs a durable
  // Cloud binding; /join reuses an existing agent and persists that binding
  // before returning to chat. With ZERO rows, the account's rowless personal
  // Eliza is the runtime: entry resolves its authoritative binding here and
  // only falls back to /join (which owns the retryable error UI) when the
  // identity cannot be resolved.
  if (!isCloudManagementPath) {
    if (route.kind === "create") {
      if (personalEntry.isError) {
        return <Navigate to="/join" replace />;
      }
      if (personalEntry.data === undefined) {
        return <EntryNotice label="Opening your Eliza" />;
      }
      return <>{appElement}</>;
    }
    if (loadPersistedActiveServer()?.kind !== "cloud") {
      return <Navigate to="/join" replace />;
    }
  }
  return <>{appElement}</>;
}

export default AppModeEntryRoute;
