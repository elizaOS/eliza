/**
 * `/auth/bridge` — the SSO handshake route, registered on every host and
 * role-switched by hostname (see `./sso-bridge` for the security model):
 *
 *  - mint role (elizacloud.ai / www / staging): a signed-in dashboard visit
 *    mints a one-time code and bounces to the paired app host; a signed-out
 *    one bounces straight to the app host's own login. Nothing here changes
 *    dashboard behavior on any other path.
 *  - exchange role (app.elizacloud.ai / app-staging): verifies-and-consumes
 *    the state nonce BEFORE any network call, exchanges the code, hydrates
 *    this origin's session, and lands on the sanitized returnTo.
 *  - every other hostname (localhost, previews, per-agent subdomains): inert —
 *    an immediate local redirect home, no bridge code paths reachable.
 *
 * Every failure path lands on the app origin's OWN /login (the loop-guard
 * marker set at initiation keeps that login from bouncing back here), and the
 * transient legs use replace-style navigation so Back never re-enters the
 * handshake.
 */

import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { appModeNavigation } from "../app-mode/app-mode";
import { hasHydratableStewardToken } from "../lib/steward-session";
import {
  buildBridgeExchangeUrl,
  consumeSsoBridgeState,
  isWellFormedSsoCode,
  isWellFormedSsoState,
  mintSsoCode,
  pairedAppOrigin,
  performSsoExchange,
  sanitizeBridgeReturnTo,
  ssoBridgeRoleForHostname,
} from "./sso-bridge";

function BridgeNotice({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="theme-cloud flex min-h-dvh flex-col items-center justify-center bg-black px-6 text-center text-white">
      <p className="font-mono text-[11px] uppercase tracking-[0.32em] text-white/62">
        {label}
      </p>
    </div>
  );
}

/** The paired app origin's own login, with the sanitized returnTo preserved. */
function appLoginUrl(appOrigin: string, returnTo: string): string {
  return `${appOrigin}/login?returnTo=${encodeURIComponent(returnTo)}`;
}

function MintLeg({
  hostname,
  state,
  returnTo,
}: {
  hostname: string;
  state: string;
  returnTo: string;
}): React.JSX.Element {
  const startedRef = useRef(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const appOrigin = pairedAppOrigin(hostname);
    if (!appOrigin) return;

    if (!hasHydratableStewardToken()) {
      // No dashboard session to bridge FROM (signed out here, or logout just
      // cleared it): hand the visitor to the app host's own login. The app
      // side's loop guard keeps this from ping-ponging.
      appModeNavigation.replace(appLoginUrl(appOrigin, returnTo));
      return;
    }

    void mintSsoCode(hostname).then((result) => {
      const url = result.ok
        ? buildBridgeExchangeUrl(hostname, result.code, state, returnTo)
        : null;
      appModeNavigation.replace(url ?? appLoginUrl(appOrigin, returnTo));
    });
  }, [hostname, state, returnTo]);

  return <BridgeNotice label="Connecting to the Eliza app" />;
}

function ExchangeLeg({
  hostname,
  code,
  state,
  returnTo,
}: {
  hostname: string;
  code: string | null;
  state: string | null;
  returnTo: string;
}): React.JSX.Element {
  const startedRef = useRef(false);
  const navigate = useNavigate();
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;

    // State nonce first, before ANY network call: the stored value is
    // consumed single-shot, and only an exact echo of what THIS origin
    // created may proceed. Missing/mismatched state (a handshake this origin
    // never initiated — login CSRF) aborts to the local login and the code is
    // never presented for exchange.
    const stored = consumeSsoBridgeState();
    const stateOk =
      stored !== null && isWellFormedSsoState(state) && stored === state;
    if (!stateOk || !isWellFormedSsoCode(code)) {
      setFailed(true);
      return;
    }

    void performSsoExchange(code, hostname).then((result) => {
      if (result.ok) {
        navigate(returnTo, { replace: true });
        return;
      }
      setFailed(true);
    });
  }, [hostname, code, state, returnTo, navigate]);

  if (failed) {
    return (
      <Navigate
        to={`/login?returnTo=${encodeURIComponent(returnTo)}`}
        replace
      />
    );
  }
  return <BridgeNotice label="Signing you in" />;
}

export function SsoBridgeRoute({
  hostname = typeof window === "undefined" ? "" : window.location.hostname,
}: {
  /** Injectable for tests; production always uses the real hostname. */
  hostname?: string;
}): React.JSX.Element {
  const location = useLocation();
  const params = new URLSearchParams(location.search);
  const returnTo = sanitizeBridgeReturnTo(params.get("returnTo"));
  const role = ssoBridgeRoleForHostname(hostname);

  if (role === "none") {
    return <Navigate to="/" replace />;
  }

  if (role === "mint") {
    const state = params.get("state");
    if (!isWellFormedSsoState(state)) {
      // A mint visit without a well-formed nonce was not initiated by the app
      // origin — treat it as any other unknown dashboard path.
      return <Navigate to="/" replace />;
    }
    return <MintLeg hostname={hostname} state={state} returnTo={returnTo} />;
  }

  return (
    <ExchangeLeg
      hostname={hostname}
      code={params.get("code")}
      state={params.get("state")}
      returnTo={returnTo}
    />
  );
}

/** Prop-less page wrapper — the route registry mounts components without
 * props; the injectable-hostname component above stays for the test matrix. */
export default function SsoBridgeRoutePage(): React.JSX.Element {
  return <SsoBridgeRoute />;
}
