/**
 * `/auth/bridge` — the SSO handshake route, registered on every host and
 * role-switched by hostname (see `./sso-bridge` for the security model):
 *
 *  - mint role (eliza.app / staging.eliza.app): a signed-in auth-origin visit
 *    that arrived FROM the paired app origin (referrer-gated — a public GET
 *    that mints on any cross-site navigation would be a CSRF-triggerable
 *    minting oracle) mints a one-time code bound to the app origin's PKCE
 *    challenge and bounces to the paired app host; anything else bounces to
 *    the app host's own login (signed out) or home (not app-initiated).
 *    Nothing here changes public-site behavior on any other path.
 *  - exchange role (cloud.eliza.app / cloud-staging.eliza.app): verifies and consumes
 *    the state nonce BEFORE any network call, exchanges the code with the
 *    stored verifier, hydrates this origin's session, and lands on the
 *    sanitized returnTo. A handshake this origin refuses (state mismatch,
 *    missing verifier) BURNS the code server-side before falling back to
 *    login, so the abandoned code cannot be redeemed later.
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
  burnSsoBridgeCode,
  consumeSsoBridgeState,
  consumeSsoBridgeVerifier,
  isWellFormedSsoChallenge,
  isWellFormedSsoCode,
  isWellFormedSsoState,
  mintSsoCode,
  pairedAppOrigin,
  performSsoExchange,
  SSO_BRIDGE_PATH,
  sanitizeBridgeReturnTo,
  ssoBridgeRoleForHostname,
} from "./sso-bridge";

const MINT_INTENT_PREFIX = "eliza.sso.mint-intent.";

function mintIntentKey(state: string): string {
  return `${MINT_INTENT_PREFIX}${state}`;
}

function rememberMintIntent(state: string): boolean {
  try {
    sessionStorage.setItem(mintIntentKey(state), "1");
    return true;
  } catch {
    // error-policy:J4 a browser that cannot retain the referrer-approved
    // intent cannot safely resume minting after a same-origin login.
    return false;
  }
}

function hasRememberedMintIntent(state: string): boolean {
  try {
    return sessionStorage.getItem(mintIntentKey(state)) === "1";
  } catch {
    // error-policy:J4 unreadable storage fails the referrer gate closed.
    return false;
  }
}

function forgetMintIntent(state: string): void {
  try {
    sessionStorage.removeItem(mintIntentKey(state));
  } catch {
    // error-policy:J6 the intent is scoped to this tab and nonce and expires
    // with the tab even when best-effort cleanup is unavailable.
  }
}

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

/**
 * The legitimate mint leg is ALWAYS a cross-origin navigation from the paired
 * app origin, whose default referrer policy (strict-origin-when-cross-origin)
 * sends exactly that origin. A third-party page cannot forge it — a forced
 * navigation carries the attacker's origin or (with a no-referrer policy)
 * nothing. Privacy setups that strip the referrer lose the auto-bridge and
 * fall back to the ordinary login, which is the designed fail-closed path.
 */
function referrerIsPairedAppOrigin(
  appOrigin: string,
  referrer: string = document.referrer,
): boolean {
  if (!referrer) return false;
  try {
    return new URL(referrer).origin === appOrigin;
  } catch {
    // error-policy:J3 an unparseable referrer reads as "not app-initiated" and
    // the mint leg refuses to start (fail-closed).
    return false;
  }
}

function MintLeg({
  hostname,
  state,
  challenge,
  returnTo,
}: {
  hostname: string;
  state: string;
  challenge: string;
  returnTo: string;
}): React.JSX.Element {
  const startedRef = useRef(false);
  const [notInitiated, setNotInitiated] = useState(false);

  useEffect(() => {
    if (startedRef.current) return;
    startedRef.current = true;
    const appOrigin = pairedAppOrigin(hostname);
    if (!appOrigin) return;

    const referrer = document.referrer;
    const appInitiated = referrerIsPairedAppOrigin(appOrigin, referrer);
    const remembered = hasRememberedMintIntent(state);
    if (!appInitiated && !remembered) {
      if (!referrer) {
        // Referrer-stripping privacy settings make a legitimate app handoff
        // indistinguishable from a direct visit. Keep minting fail-closed, but
        // send the user to the app's ordinary login instead of stranding them
        // on the public homepage.
        appModeNavigation.replace(appLoginUrl(appOrigin, returnTo));
        return;
      }
      // Not a handshake the app origin initiated (direct visit, or a
      // third-party page forcing a signed-in user here): mint nothing.
      setNotInitiated(true);
      return;
    }

    if (appInitiated && !remembered && !rememberMintIntent(state)) {
      appModeNavigation.replace(appLoginUrl(appOrigin, returnTo));
      return;
    }

    if (!hasHydratableStewardToken()) {
      // Login is owned by this public/auth origin. Preserve the exact bridge
      // leg as a same-origin returnTo; once Steward succeeds, the remembered
      // referrer-approved intent permits minting and sends the user back to
      // the managed app. No credential is ever entered on the app host.
      const bridgeReturnTo = `${SSO_BRIDGE_PATH}?state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(challenge)}&returnTo=${encodeURIComponent(returnTo)}`;
      appModeNavigation.replace(
        `/login?returnTo=${encodeURIComponent(bridgeReturnTo)}`,
      );
      return;
    }

    forgetMintIntent(state);
    void mintSsoCode(hostname, challenge).then((result) => {
      const url = result.ok
        ? buildBridgeExchangeUrl(hostname, result.code, state, returnTo)
        : null;
      appModeNavigation.replace(url ?? appLoginUrl(appOrigin, returnTo));
    });
  }, [hostname, state, challenge, returnTo]);

  if (notInitiated) {
    return <Navigate to="/" replace />;
  }
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
    // never initiated — login CSRF) aborts to the local login; the code is
    // never EXCHANGED, but a well-formed one is BURNED so it cannot sit live
    // in the address bar and request logs for the rest of its TTL.
    const stored = consumeSsoBridgeState();
    const verifier = consumeSsoBridgeVerifier();
    const stateOk =
      stored !== null && isWellFormedSsoState(state) && stored === state;
    if (!stateOk || !isWellFormedSsoCode(code) || verifier === null) {
      if (isWellFormedSsoCode(code)) burnSsoBridgeCode(code, hostname);
      setFailed(true);
      return;
    }

    void performSsoExchange(code, verifier, hostname).then((result) => {
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
    const challenge = params.get("challenge");
    if (!isWellFormedSsoState(state) || !isWellFormedSsoChallenge(challenge)) {
      // A mint visit without a well-formed nonce + challenge was not initiated
      // by the app origin — treat it as any other unknown public-site path.
      return <Navigate to="/" replace />;
    }
    return (
      <MintLeg
        hostname={hostname}
        state={state}
        challenge={challenge}
        returnTo={returnTo}
      />
    );
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
