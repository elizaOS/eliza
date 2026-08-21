/**
 * OAuth/connector auth-success callback page (public). Renders success only
 * after a one-time, session-bound proof is consumed or an authenticated
 * ownership lookup confirms the connection. Query markers alone never claim a
 * successful connection; forwarded proofs cannot claim another visitor's
 * account.
 */

import { Capacitor } from "@capacitor/core";
import {
  AlertCircle,
  CheckCircle,
  Home,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  resolveDirectCloudAuthApiBase,
} from "../../../../api/direct-cloud-endpoints";
import { isElectrobunRuntime } from "../../../../bridge/electrobun-runtime";
import { Button } from "../../../../components/primitives";
import { getBootConfig } from "../../../../config/boot-config";
import { ApiError, api, readCloudBearerToken } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

/** Hosts that may receive OAuth success redirects but are not Eliza Cloud. */
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * True only for loopback *web* dev origins. Native/Electrobun WebViews also use
 * a localhost-like host but must keep riding {@link api} so CapacitorHttp (or
 * the desktop native bridge) reaches Cloud — raw window.fetch cannot.
 */
function isBrowserLoopbackWebOrigin(): boolean {
  if (typeof window === "undefined") return false;
  if (Capacitor.isNativePlatform() || isElectrobunRuntime()) return false;
  return LOOPBACK_HOSTS.has(window.location.hostname.toLowerCase());
}

/**
 * Resolve a Cloud API path. On Cloud / native hosts, same-origin relative paths
 * ride {@link api}. On loopback web the Vite `/api` proxy hits the local agent,
 * which does not host these Cloud OAuth routes — so use the configured Cloud
 * API origin directly.
 */
function resolveCloudApiUrl(path: string): string {
  if (!path.startsWith("/")) {
    throw new ApiError(0, "INVALID_API_PATH", "API paths must start with '/'.");
  }
  if (!isBrowserLoopbackWebOrigin()) return path;
  const cloudBase = resolveDirectCloudAuthApiBase(
    getBootConfig().cloudApiBase?.trim() || DEFAULT_DIRECT_CLOUD_API_BASE_URL,
  );
  return `${cloudBase.replace(/\/+$/, "")}${path}`;
}

/**
 * GET JSON from a Cloud path. Relative → {@link api}. Absolute loopback Cloud
 * URLs use fetch with optional bearer + cookies (ownership) or omit auth
 * (public proof verify) without opening a general cross-origin bridge in the
 * shared client.
 */
async function fetchCloudJson<T>(
  path: string,
  options: { signal?: AbortSignal; skipAuth?: boolean } = {},
): Promise<T> {
  const url = resolveCloudApiUrl(path);
  if (url.startsWith("/")) {
    return api<T>(url, {
      signal: options.signal,
      skipAuth: options.skipAuth,
    });
  }

  const headers = new Headers({ Accept: "application/json" });
  if (!options.skipAuth) {
    const token = await readCloudBearerToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      signal: options.signal,
      // Always include cookies on absolute Cloud URLs so a cookie-only ownership
      // retry (skipAuth after a stale bearer 401) can still authenticate.
      // skipAuth only omits the Authorization header, not credentials.
      credentials: "include",
      headers,
    });
  } catch (error) {
    // error-policy:J4 network failure reaching Cloud from loopback is unavailable.
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    throw new ApiError(0, "NETWORK_ERROR", "Could not reach Cloud API");
  }

  let payload: unknown = null;
  try {
    payload = await res.json();
  } catch {
    // error-policy:J3 non-JSON body is treated as an empty payload below.
    payload = null;
  }

  if (!res.ok) {
    const body =
      typeof payload === "object" && payload !== null
        ? (payload as Record<string, unknown>)
        : null;
    const message =
      (typeof body?.reason === "string" && body.reason) ||
      (typeof body?.error === "string" && body.error) ||
      (typeof body?.message === "string" && body.message) ||
      `Request failed with status ${res.status}`;
    throw new ApiError(res.status, `HTTP_${res.status}`, message, payload);
  }

  return (payload ?? {}) as T;
}

async function fetchSuccessProofVerify(
  proof: string,
  signal?: AbortSignal,
  options: { skipAuth?: boolean } = {},
): Promise<{
  ok?: boolean;
  platform?: string;
  connectionId?: string | null;
  reason?: string;
}> {
  // Proof verify requires the visitor's session cookies/bearer so the server
  // can bind the one-time ticket to the mint-time org/user.
  return fetchCloudJson(
    `/api/v1/oauth/success-proof/verify?proof=${encodeURIComponent(proof)}`,
    { signal, skipAuth: options.skipAuth ?? false },
  );
}

/**
 * Display names for every provider id the cloud OAuth callback may emit on
 * `/auth/success` (aligned with `OAUTH_PROVIDERS` plus connector-native
 * Discord). Unknown values never become a trust signal on this route.
 */
// Null-prototype map so untrusted query values like `constructor` cannot
// resolve inherited Object.prototype members as "known" platforms.
const PLATFORM_NAMES: Record<string, string> = Object.assign(
  Object.create(null) as Record<string, string>,
  {
    google: "Google",
    microsoft: "Microsoft",
    linear: "Linear",
    notion: "Notion",
    github: "GitHub",
    slack: "Slack",
    hubspot: "HubSpot",
    asana: "Asana",
    dropbox: "Dropbox",
    salesforce: "Salesforce",
    airtable: "Airtable",
    zoom: "Zoom",
    jira: "Jira",
    linkedin: "LinkedIn",
    twitter: "Twitter",
    discord: "Discord",
    twilio: "Twilio",
    blooio: "Blooio",
  },
);

const TRUTHY_CONNECTED = new Set(["true", "1", "yes"]);

export type AuthSuccessCandidate =
  | {
      kind: "candidate";
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
      proof: string | null;
    }
  | {
      kind: "unverified";
      reason: "missing" | "untrusted";
    };

export type AuthSuccessViewState =
  | {
      phase: "pending";
      candidate: Extract<AuthSuccessCandidate, { kind: "candidate" }>;
    }
  | {
      phase: "verified";
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
    }
  | { phase: "unverified"; reason: "missing" | "untrusted" | "rejected" }
  | { phase: "unavailable" };

/**
 * Parse the callback query into a verification *candidate*. Query markers alone
 * never claim success — {@link verifyAuthSuccessCandidate} must confirm via a
 * callback-bound HMAC proof and/or an authenticated ownership lookup.
 */
export function resolveAuthSuccessCandidate(
  searchParams: URLSearchParams,
): AuthSuccessCandidate {
  const connectionIdRaw = searchParams.get("connection_id");
  const connectionId =
    connectionIdRaw && connectionIdRaw.trim().length > 0
      ? connectionIdRaw.trim()
      : null;
  const proofRaw = searchParams.get("proof");
  const proof = proofRaw && proofRaw.trim().length > 0 ? proofRaw.trim() : null;

  // Explicit `platform=` from the callback wins over any leftover `*_connected`
  // markers that a query-bearing redirectUrl may have retained from an earlier
  // attempt (callbacks preserve unrelated params).
  const platformParam =
    searchParams.get("platform")?.trim().toLowerCase() || null;

  let connectedPlatform: string | null = null;
  for (const [key, value] of searchParams.entries()) {
    if (!key.endsWith("_connected")) continue;
    if (!TRUTHY_CONNECTED.has(value.trim().toLowerCase())) continue;
    const candidate = key.slice(0, -"_connected".length).toLowerCase();
    if (candidate.length === 0) continue;
    connectedPlatform = candidate;
    break;
  }

  const platform = platformParam ?? connectedPlatform;

  if (!platform && !connectionId && !proof) {
    return { kind: "unverified", reason: "missing" };
  }

  if (!platform || !PLATFORM_NAMES[platform]) {
    return { kind: "unverified", reason: "untrusted" };
  }

  // A candidate needs either a callback-bound proof or a connection id to look
  // up. Forged `*_connected=true` alone is never enough.
  if (!proof && !connectionId) {
    return { kind: "unverified", reason: "untrusted" };
  }

  return {
    kind: "candidate",
    platform,
    platformDisplay: PLATFORM_NAMES[platform],
    connectionId,
    proof,
  };
}

/** @deprecated Prefer {@link resolveAuthSuccessCandidate}. */
export function resolveAuthSuccessSignal(
  searchParams: URLSearchParams,
): AuthSuccessCandidate {
  return resolveAuthSuccessCandidate(searchParams);
}

/** 5xx/0/network and 429 (rate limit) are retryable; other 4xx are rejected. */
function isRetryableApiFailure(error: ApiError): boolean {
  return error.status >= 500 || error.status === 0 || error.status === 429;
}

async function verifyProof(args: {
  proof: string;
  platform: string;
  connectionId: string | null;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
    }
  | { ok: false; reason: "rejected" | "unavailable" }
> {
  const interpret = (data: {
    ok?: boolean;
    platform?: string;
    connectionId?: string | null;
  }):
    | {
        ok: true;
        platform: string;
        platformDisplay: string;
        connectionId: string | null;
      }
    | { ok: false; reason: "rejected" } => {
    if (!data?.ok || typeof data.platform !== "string") {
      return { ok: false, reason: "rejected" };
    }
    const platform = data.platform.trim().toLowerCase();
    if (platform !== args.platform || !PLATFORM_NAMES[platform]) {
      return { ok: false, reason: "rejected" };
    }
    const proofConnectionId =
      typeof data.connectionId === "string" && data.connectionId.trim()
        ? data.connectionId.trim()
        : null;
    if (
      args.connectionId &&
      proofConnectionId &&
      args.connectionId !== proofConnectionId
    ) {
      return { ok: false, reason: "rejected" };
    }
    return {
      ok: true,
      platform,
      platformDisplay: PLATFORM_NAMES[platform],
      connectionId: proofConnectionId ?? args.connectionId,
    };
  };

  try {
    const data = await fetchSuccessProofVerify(args.proof, args.signal);
    return interpret(data);
  } catch (error) {
    // error-policy:J4 proof-verify transport failures become unavailable;
    // 4xx from the verifier is an explicit rejected proof. Retry cookie-only
    // after a bearer 401 so a stale Steward JWT does not mask a valid cookie.
    if (error instanceof DOMException && error.name === "AbortError")
      throw error;
    if (error instanceof ApiError) {
      if (isRetryableApiFailure(error)) {
        return { ok: false, reason: "unavailable" };
      }
      if (error.status === 401 && (await readCloudBearerToken())?.trim()) {
        try {
          const data = await fetchSuccessProofVerify(args.proof, args.signal, {
            skipAuth: true,
          });
          return interpret(data);
        } catch (retryError) {
          // error-policy:J4 cookie-only proof retry: same unavailable/rejected mapping.
          if (
            retryError instanceof DOMException &&
            retryError.name === "AbortError"
          ) {
            throw retryError;
          }
          if (retryError instanceof ApiError) {
            if (isRetryableApiFailure(retryError)) {
              return { ok: false, reason: "unavailable" };
            }
            return { ok: false, reason: "rejected" };
          }
          return { ok: false, reason: "unavailable" };
        }
      }
      return { ok: false, reason: "rejected" };
    }
    return { ok: false, reason: "unavailable" };
  }
}

async function verifyConnectionOwnership(args: {
  platform: string;
  connectionId: string;
  signal?: AbortSignal;
  /** Cookie-only probe — used after a bearer-authenticated 401. */
  skipAuth?: boolean;
}): Promise<
  | {
      ok: true;
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
    }
  | { ok: false; reason: "rejected" | "unauthorized" | "unavailable" }
> {
  try {
    const data = await fetchCloudJson<{
      connection?: { id?: string; platform?: string; status?: string };
    }>(`/api/v1/oauth/connections/${encodeURIComponent(args.connectionId)}`, {
      signal: args.signal,
      skipAuth: args.skipAuth,
    });
    const connection = data.connection;
    if (!connection || typeof connection !== "object") {
      return { ok: false, reason: "rejected" };
    }
    const connectionPlatform =
      typeof connection.platform === "string"
        ? connection.platform.trim().toLowerCase()
        : "";
    if (connectionPlatform !== args.platform) {
      return { ok: false, reason: "rejected" };
    }
    if (
      typeof connection.id === "string" &&
      connection.id.trim() &&
      connection.id.trim() !== args.connectionId
    ) {
      return { ok: false, reason: "rejected" };
    }
    // Status is required from the producer — never invent "active".
    if (typeof connection.status !== "string" || !connection.status.trim()) {
      return { ok: false, reason: "rejected" };
    }
    const status = connection.status.trim().toLowerCase();
    if (status !== "active" && status !== "connected") {
      return { ok: false, reason: "rejected" };
    }
    return {
      ok: true,
      platform: args.platform,
      platformDisplay: PLATFORM_NAMES[args.platform] ?? args.platform,
      connectionId: args.connectionId,
    };
  } catch (error) {
    // error-policy:J4 ownership lookup failures: 5xx/network/429 → unavailable;
    // 401/403 → unauthorized (no session); 404/other 4xx → rejected.
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    if (error instanceof ApiError) {
      if (isRetryableApiFailure(error)) {
        return { ok: false, reason: "unavailable" };
      }
      // Only 401 means "no browser session" (sessionless API-key OAuth may
      // still accept a valid callback proof). 403 is an authenticated deny
      // (inactive user/org, missing membership) and must stay rejected.
      if (error.status === 401) {
        return { ok: false, reason: "unauthorized" };
      }
      return { ok: false, reason: "rejected" };
    }
    return { ok: false, reason: "unavailable" };
  }
}

function asVerifyFailure(reason: "rejected" | "unauthorized" | "unavailable"): {
  ok: false;
  reason: "rejected" | "unavailable";
} {
  // unauthorized is an internal ownership probe signal; callers map it.
  return { ok: false, reason: reason === "unauthorized" ? "rejected" : reason };
}

/**
 * Ownership probe that unmasks a valid cookie session when a stale Steward
 * bearer in localStorage caused the first lookup to 401.
 */
async function resolveConnectionOwnership(args: {
  platform: string;
  connectionId: string;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
    }
  | { ok: false; reason: "rejected" | "unauthorized" | "unavailable" }
> {
  const hadBearer = Boolean((await readCloudBearerToken())?.trim());
  const first = await verifyConnectionOwnership(args);
  if (first.ok || first.reason !== "unauthorized" || !hadBearer) {
    return first;
  }
  return verifyConnectionOwnership({
    ...args,
    skipAuth: true,
  });
}

/**
 * Confirm a candidate via a one-time session-bound proof and/or authenticated
 * connection ownership. The verify endpoint requires a matching browser
 * session and consumes the nonce, so a forwarded URL cannot claim Connected
 * for an anonymous or different visitor. Sessionless API-key OAuth fails
 * closed here — ownership of `connection_id` is the only non-proof path.
 */
export async function verifyAuthSuccessCandidate(args: {
  platform: string;
  connectionId: string | null;
  proof: string | null;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
    }
  | { ok: false; reason: "rejected" | "unavailable" }
> {
  if (args.proof) {
    const proofResult = await verifyProof({
      proof: args.proof,
      platform: args.platform,
      connectionId: args.connectionId,
      signal: args.signal,
    });

    if (proofResult.ok) {
      // Server already bound the ticket to this session and consumed the nonce.
      return proofResult;
    }

    if (!args.connectionId) return proofResult;
    // Soft-fail into ownership when proof fails but connection_id remains
    // (expired/replayed proof / secret cutover) for sessioned browsers.
    const ownership = await resolveConnectionOwnership({
      platform: args.platform,
      connectionId: args.connectionId,
      signal: args.signal,
    });
    if (ownership.ok) return ownership;
    if (proofResult.reason === "unavailable") return proofResult;
    if (ownership.reason === "unavailable") {
      return { ok: false, reason: "unavailable" };
    }
    return { ok: false, reason: "rejected" };
  }

  if (!args.connectionId) {
    return { ok: false, reason: "rejected" };
  }

  const ownership = await resolveConnectionOwnership({
    platform: args.platform,
    connectionId: args.connectionId,
    signal: args.signal,
  });
  if (ownership.ok) return ownership;
  return asVerifyFailure(ownership.reason);
}

/** @deprecated Prefer {@link verifyAuthSuccessCandidate}. */
export async function verifyAuthSuccessConnection(args: {
  platform: string;
  connectionId: string;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
    }
  | { ok: false; reason: "rejected" | "unavailable" }
> {
  return verifyAuthSuccessCandidate({
    platform: args.platform,
    connectionId: args.connectionId,
    proof: null,
    signal: args.signal,
  });
}

export default function AuthSuccessPage() {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const candidate = useMemo(
    () => resolveAuthSuccessCandidate(searchParams),
    [searchParams],
  );
  const [view, setView] = useState<AuthSuccessViewState>(() =>
    candidate.kind === "candidate"
      ? { phase: "pending", candidate }
      : { phase: "unverified", reason: candidate.reason },
  );

  usePageTitle(
    view.phase === "verified"
      ? t("cloud.authSuccess.metaTitle", {
          defaultValue: "Connection Successful | Eliza Cloud",
        })
      : view.phase === "pending"
        ? t("cloud.authSuccess.pendingMetaTitle", {
            defaultValue: "Verifying Connection | Eliza Cloud",
          })
        : view.phase === "unavailable"
          ? t("cloud.authSuccess.unavailableMetaTitle", {
              defaultValue: "Verification Unavailable | Eliza Cloud",
            })
          : t("cloud.authSuccess.unverifiedMetaTitle", {
              defaultValue: "Connection Could Not Be Verified | Eliza Cloud",
            }),
  );

  useEffect(() => {
    if (candidate.kind !== "candidate") {
      setView({ phase: "unverified", reason: candidate.reason });
      return;
    }
    const controller = new AbortController();
    setView({ phase: "pending", candidate });
    void verifyAuthSuccessCandidate({
      platform: candidate.platform,
      connectionId: candidate.connectionId,
      proof: candidate.proof,
      signal: controller.signal,
    })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (result.ok) {
          setView({
            phase: "verified",
            platform: result.platform,
            platformDisplay: result.platformDisplay,
            connectionId: result.connectionId,
          });
          return;
        }
        if (result.reason === "unavailable") {
          setView({ phase: "unavailable" });
          return;
        }
        setView({ phase: "unverified", reason: "rejected" });
      })
      .catch((error: unknown) => {
        // error-policy:J4 unexpected verify failures become unavailable UI,
        // never a forged success. Abort is ignored on unmount.
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setView({ phase: "unavailable" });
      });
    return () => controller.abort();
  }, [candidate]);

  useEffect(() => {
    if (view.phase !== "verified") return;
    if (!window.opener || window.opener.closed) return;
    const timer = setTimeout(() => {
      window.close();
    }, 2000);
    return () => clearTimeout(timer);
  }, [view.phase]);

  if (view.phase === "pending") {
    return (
      <div className="theme-cloud relative flex min-h-[100dvh] items-center justify-center bg-bg p-4">
        <div className="relative w-full max-w-md bg-card border border-border p-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center bg-bg-muted">
              <Loader2
                className="h-7 w-7 animate-spin text-muted"
                aria-hidden
              />
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-txt">
                {t("cloud.authSuccess.pendingTitle", {
                  defaultValue: "Verifying Connection",
                })}
              </h1>
              <p className="text-sm text-muted">
                {t("cloud.authSuccess.pendingDescription", {
                  defaultValue: "Confirming this connection with Eliza Cloud…",
                })}
              </p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view.phase === "unavailable") {
    return (
      <div className="theme-cloud relative flex min-h-[100dvh] items-center justify-center bg-bg p-4">
        <div className="relative w-full max-w-md bg-card border border-border p-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center bg-bg-muted">
              <AlertCircle className="h-7 w-7 text-muted" aria-hidden />
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-txt">
                {t("cloud.authSuccess.unavailableTitle", {
                  defaultValue: "Could Not Reach Eliza Cloud",
                })}
              </h1>
              <p className="text-sm text-muted">
                {t("cloud.authSuccess.unavailableDescription", {
                  defaultValue:
                    "We could not verify this connection because the verification service is temporarily unavailable. Try again in a moment.",
                })}
              </p>
            </div>
            <div className="w-full space-y-3">
              <Button
                onClick={() => window.location.reload()}
                className="w-full h-11 bg-accent hover:bg-accent-hover text-accent-foreground"
              >
                <RefreshCw className="h-4 w-4 mr-2" aria-hidden />
                {t("cloud.authSuccess.tryAgain", {
                  defaultValue: "Try Again",
                })}
              </Button>
              <Button
                variant="outline"
                asChild
                className="w-full h-11 border-border hover:bg-bg-hover"
              >
                <Link to="/">
                  <Home className="h-4 w-4 mr-2" aria-hidden />
                  {t("cloud.authSuccess.goHome", { defaultValue: "Go Home" })}
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (view.phase === "unverified") {
    const description =
      view.reason === "untrusted" || view.reason === "rejected"
        ? t("cloud.authSuccess.untrustedDescription", {
            defaultValue:
              "This connection link could not be verified. It may be incomplete, expired, or not issued by Eliza Cloud.",
          })
        : t("cloud.authSuccess.missingDescription", {
            defaultValue:
              "No verified connection result was found. Start the connection again from the app.",
          });

    return (
      <div className="theme-cloud relative flex min-h-[100dvh] items-center justify-center bg-bg p-4">
        <div className="relative w-full max-w-md bg-card border border-border p-8">
          <div className="flex flex-col items-center gap-6 text-center">
            <div className="flex h-14 w-14 items-center justify-center bg-destructive-subtle">
              <AlertCircle className="h-7 w-7 text-destructive" aria-hidden />
            </div>
            <div className="space-y-2">
              <h1 className="text-xl font-semibold text-txt">
                {t("cloud.authSuccess.unverifiedTitle", {
                  defaultValue: "Connection Could Not Be Verified",
                })}
              </h1>
              <p className="text-sm text-muted">{description}</p>
            </div>

            <div className="w-full space-y-3">
              <Button
                onClick={() => navigate("/login")}
                className="w-full h-11 bg-accent hover:bg-accent-hover text-accent-foreground"
              >
                <RefreshCw className="h-4 w-4 mr-2" aria-hidden />
                {t("cloud.authSuccess.backToSignIn", {
                  defaultValue: "Back to Sign In",
                })}
              </Button>
              <Button
                variant="outline"
                asChild
                className="w-full h-11 border-border hover:bg-bg-hover"
              >
                <Link to="/">
                  <Home className="h-4 w-4 mr-2" aria-hidden />
                  {t("cloud.authSuccess.goHome", { defaultValue: "Go Home" })}
                </Link>
              </Button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const { platformDisplay } = view;

  return (
    <div className="theme-cloud relative flex min-h-[100dvh] items-center justify-center bg-bg p-4">
      <div className="relative w-full max-w-md bg-card border border-border p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center bg-status-success-bg">
            <CheckCircle className="h-7 w-7 text-status-success" aria-hidden />
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-semibold text-txt">
              {t("cloud.authSuccess.platformConnected", {
                platform: platformDisplay,
                defaultValue: "{{platform}} Connected",
              })}
            </h1>
            <p className="text-sm text-muted">
              {t("cloud.authSuccess.platformAccountConnected", {
                platform: platformDisplay,
                defaultValue:
                  "Your {{platform}} account has been connected successfully.",
              })}
            </p>
          </div>

          <p className="text-xs text-muted">
            {t("cloud.authSuccess.returnToApp", {
              defaultValue: "Return to the app to continue.",
            })}
          </p>

          <div className="w-full">
            <Button
              variant="outline"
              asChild
              className="w-full h-11 border-border hover:bg-bg-hover"
            >
              <Link to="/">
                {t("cloud.authSuccess.returnToAppCta", {
                  defaultValue: "Return to App",
                })}
              </Link>
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
