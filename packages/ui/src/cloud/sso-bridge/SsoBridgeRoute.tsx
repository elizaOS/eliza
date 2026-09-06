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
 * Expected failures return to the app origin's own login; unexpected mint
 * failures use the distinct authentication-error page with a retry destination.
 * The loop guard suppresses repeated handshakes, and replace-style navigation
 * keeps Back from re-entering a completed bridge leg.
 */

import { ElizaError } from "@elizaos/core";
import { readStoredStewardToken } from "@elizaos/shared/steward-session-client";
import { useEffect, useRef, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Card } from "../../components/ui/card";
import { reportRendererDiagnostic } from "../../utils/renderer-diagnostics";
import { appModeNavigation } from "../app-mode/app-mode";
import { hasHydratableStewardToken } from "../lib/steward-session";
import {
  buildBridgeExchangeUrl,
  buildSsoBridgeErrorUrl,
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
    <Card asChild surface="card" radius="none" tone="inverse">
      <div className="theme-cloud flex min-h-dvh flex-col items-center justify-center px-6 text-center">
        <p className="font-mono text-xs-tight uppercase tracking-[0.32em] text-white/62">
          {label}
        </p>
      </div>
    </Card>
  );
}

/** The paired app origin's own login, with the sanitized returnTo preserved. */
function appLoginUrl(appOrigin: string, returnTo: string): string {
  return `${appOrigin}/login?returnTo=${encodeURIComponent(returnTo)}`;
}

/**
 * Remove single-use exchange credentials from the visible URL without
 * notifying the router. ExchangeLeg already captured both values as props, so
 * this attempt can continue while copied links and browser history retain only
 * the non-secret callback context.
 */
function stripExchangeCredentialsFromAddressBar(): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (!url.searchParams.has("code") && !url.searchParams.has("state")) return;
  url.searchParams.delete("code");
  url.searchParams.delete("state");
  window.history.replaceState(
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`,
  );
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

type MintedCodeHandoff = {
  /** Recheck the minting account at the navigation boundary. */
  isCurrent(): boolean;
  /** Destroy the code while this document still owns it. Idempotent. */
  burn(): void;
  /** Relinquish custody after the browser accepts the app-origin navigation. */
  transfer(): void;
};

type MintLegOutcome =
  | { kind: "not-initiated" }
  | { handoff?: MintedCodeHandoff; kind: "redirect"; url: string };

/** Run one challenge-bound mint transaction for the component lifetime. */
async function runMintLegOperation(
  hostname: string,
  state: string,
  challenge: string,
  returnTo: string,
): Promise<MintLegOutcome> {
  const appOrigin = pairedAppOrigin(hostname);
  if (!appOrigin) return { kind: "not-initiated" };

  const referrer = document.referrer;
  const appInitiated = referrerIsPairedAppOrigin(appOrigin, referrer);
  const remembered = hasRememberedMintIntent(state);
  if (!appInitiated && !remembered) {
    if (!referrer) {
      // Referrer-stripping privacy settings make a legitimate app handoff
      // indistinguishable from a direct visit. Keep minting fail-closed, but
      // send the user to the app's ordinary login instead of stranding them
      // on the public homepage.
      return { kind: "redirect", url: appLoginUrl(appOrigin, returnTo) };
    }
    // Not a handshake the app origin initiated (direct visit, or a
    // third-party page forcing a signed-in user here): mint nothing.
    return { kind: "not-initiated" };
  }

  if (appInitiated && !remembered && !rememberMintIntent(state)) {
    return { kind: "redirect", url: appLoginUrl(appOrigin, returnTo) };
  }

  if (!hasHydratableStewardToken()) {
    // Login is owned by this public/auth origin. Preserve the exact bridge
    // leg as a same-origin returnTo; once Steward succeeds, the remembered
    // referrer-approved intent permits minting and sends the user back to
    // the managed app. No credential is ever entered on the app host.
    const bridgeReturnTo = `${SSO_BRIDGE_PATH}?state=${encodeURIComponent(state)}&challenge=${encodeURIComponent(challenge)}&returnTo=${encodeURIComponent(returnTo)}`;
    return {
      kind: "redirect",
      url: `/login?returnTo=${encodeURIComponent(bridgeReturnTo)}`,
    };
  }

  forgetMintIntent(state);
  const mintingToken = readStoredStewardToken();
  let mintedCode: string | null = null;
  const burnMintedCodeOnce = (): void => {
    if (!mintedCode) return;
    const code = mintedCode;
    mintedCode = null;
    burnSsoBridgeCode(code, hostname);
  };

  try {
    const result = await mintSsoCode(hostname, challenge);
    if (!result.ok) {
      return { kind: "redirect", url: appLoginUrl(appOrigin, returnTo) };
    }

    mintedCode = result.code;
    if (
      readStoredStewardToken() !== mintingToken ||
      !hasHydratableStewardToken()
    ) {
      burnMintedCodeOnce();
      return { kind: "redirect", url: appLoginUrl(appOrigin, returnTo) };
    }
    const url = buildBridgeExchangeUrl(hostname, result.code, state, returnTo);
    if (!url) {
      burnMintedCodeOnce();
      return { kind: "redirect", url: appLoginUrl(appOrigin, returnTo) };
    }

    return {
      handoff: {
        isCurrent: () =>
          readStoredStewardToken() === mintingToken &&
          hasHydratableStewardToken(),
        burn: burnMintedCodeOnce,
        transfer: () => {
          mintedCode = null;
        },
      },
      kind: "redirect",
      url,
    };
  } catch (error) {
    // error-policy:J2 a late failure after mint first relinquishes local code
    // custody, then reaches the UI boundary as a typed failure with its cause.
    burnMintedCodeOnce();
    throw new ElizaError("SSO mint handoff failed after code issuance", {
      code: "SSO_BRIDGE_MINT_HANDOFF_FAILED",
      cause: error,
      severity: "fatal",
      context: { hostname },
    });
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
  const operationRef = useRef<{
    activeEffects: Set<number>;
    key: string;
    promise: Promise<MintLegOutcome>;
  } | null>(null);
  const effectGenerationRef = useRef(0);
  const [notInitiated, setNotInitiated] = useState(false);
  const [unexpectedFailure, setUnexpectedFailure] = useState(false);

  useEffect(() => {
    const effectGeneration = effectGenerationRef.current + 1;
    effectGenerationRef.current = effectGeneration;
    const effectIsCurrent = () =>
      effectGenerationRef.current === effectGeneration;
    const operationKey = JSON.stringify([hostname, state, challenge, returnTo]);
    const previousOperation = operationRef.current;
    const operation =
      previousOperation?.key === operationKey
        ? previousOperation
        : {
            activeEffects: new Set<number>(),
            key: operationKey,
            promise: runMintLegOperation(hostname, state, challenge, returnTo),
          };
    operationRef.current = operation;
    operation.activeEffects.add(effectGeneration);

    const redirectToAppLogin = (): boolean => {
      const appOrigin = pairedAppOrigin(hostname);
      try {
        appModeNavigation.replace(
          appOrigin ? appLoginUrl(appOrigin, returnTo) : "/",
        );
        return true;
      } catch (error) {
        // error-policy:J1 the UI navigation boundary reports the browser error;
        // its caller renders the distinct authentication-error route.
        reportRendererDiagnostic({
          scope: "steward.sso-bridge.login-navigation",
          error,
          severity: "error",
        });
        return false;
      }
    };

    void operation.promise
      .then((outcome) => {
        if (!effectIsCurrent()) {
          if (outcome.kind === "redirect" && outcome.handoff) {
            // StrictMode immediately re-subscribes to the same operation. A
            // microtask distinguishes that replay from a real abandonment.
            queueMicrotask(() => {
              if (operation.activeEffects.size === 0) outcome.handoff?.burn();
            });
          }
          return;
        }
        if (outcome.kind === "not-initiated") {
          setNotInitiated(true);
          return;
        }
        if (outcome.handoff && !outcome.handoff.isCurrent()) {
          outcome.handoff.burn();
          if (!redirectToAppLogin()) setUnexpectedFailure(true);
          return;
        }
        try {
          appModeNavigation.replace(outcome.url);
          outcome.handoff?.transfer();
        } catch (error) {
          // error-policy:J1 report the failed handoff navigation at the UI
          // boundary before burning custody. Only the expected browser-policy
          // rejection degrades to the safe login path.
          reportRendererDiagnostic({
            scope: "steward.sso-bridge.handoff-navigation",
            error,
            severity: "error",
          });
          outcome.handoff?.burn();
          if (
            !(
              error instanceof DOMException && error.name === "SecurityError"
            ) ||
            !redirectToAppLogin()
          ) {
            setUnexpectedFailure(true);
          }
        }
      })
      .catch((error) => {
        // error-policy:J1 an unforeseen lifecycle rejection is reported and
        // becomes a visibly distinct error route rather than ordinary login.
        reportRendererDiagnostic({
          scope: "steward.sso-bridge.mint-lifecycle",
          error,
          severity: "error",
        });
        if (effectIsCurrent()) setUnexpectedFailure(true);
      });

    return () => {
      operation.activeEffects.delete(effectGeneration);
      if (effectIsCurrent()) {
        effectGenerationRef.current = effectGeneration + 1;
      }
    };
  }, [hostname, state, challenge, returnTo]);

  if (unexpectedFailure) {
    return (
      <Navigate to={buildSsoBridgeErrorUrl("auth_failed", returnTo)} replace />
    );
  }
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
    stripExchangeCredentialsFromAddressBar();

    // State nonce first, before ANY network call: the stored value is
    // consumed single-shot, and only an exact echo of what THIS origin
    // created may proceed. Missing/mismatched state (a handshake this origin
    // never initiated — login CSRF) aborts to the local login; the code is
    // never EXCHANGED, but a well-formed one is BURNED so it cannot remain
    // redeemable from previously recorded redirect/request logs for its TTL.
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
