/**
 * OAuth/connector auth-success callback page (public). Renders success only
 * after an authenticated backend lookup confirms the referenced connection
 * exists and belongs to the current org/user. Query markers alone never claim
 * a successful connection.
 */

import {
  AlertCircle,
  CheckCircle,
  Home,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/primitives";
import { ApiError, api } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

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
      connectionId: string;
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
      connectionId: string;
    }
  | { phase: "unverified"; reason: "missing" | "untrusted" | "rejected" };

/**
 * Parse the callback query into a verification *candidate*. Presence of
 * `*_connected` / `connection_id` alone is never enough to claim success —
 * {@link verifyAuthSuccessConnection} must confirm ownership server-side.
 */
export function resolveAuthSuccessCandidate(
  searchParams: URLSearchParams,
): AuthSuccessCandidate {
  const connectionIdRaw = searchParams.get("connection_id");
  const connectionId =
    connectionIdRaw && connectionIdRaw.trim().length > 0
      ? connectionIdRaw.trim()
      : null;

  let connectedPlatform: string | null = null;
  for (const [key, value] of searchParams.entries()) {
    if (!key.endsWith("_connected")) continue;
    if (!TRUTHY_CONNECTED.has(value.trim().toLowerCase())) continue;
    const candidate = key.slice(0, -"_connected".length).toLowerCase();
    if (candidate.length === 0) continue;
    connectedPlatform = candidate;
    break;
  }

  const platformParam =
    searchParams.get("platform")?.trim().toLowerCase() || null;
  const platform = connectedPlatform ?? platformParam;

  if (!platform && !connectionId) {
    return { kind: "unverified", reason: "missing" };
  }

  if (!platform || !PLATFORM_NAMES[platform]) {
    return { kind: "unverified", reason: "untrusted" };
  }

  // Require a concrete connection id. Forged `*_connected=true` alone is not
  // a verification candidate.
  if (!connectionId) {
    return { kind: "unverified", reason: "untrusted" };
  }

  const hasConnectedFlag = connectedPlatform === platform;
  if (!hasConnectedFlag) {
    // connection_id + known platform is still a candidate — backend decides.
  }

  return {
    kind: "candidate",
    platform,
    platformDisplay: PLATFORM_NAMES[platform],
    connectionId,
  };
}

/** @deprecated Prefer {@link resolveAuthSuccessCandidate}. */
export function resolveAuthSuccessSignal(
  searchParams: URLSearchParams,
): AuthSuccessCandidate {
  return resolveAuthSuccessCandidate(searchParams);
}

/**
 * Confirm the candidate connection with the control plane. Requires an
 * authenticated session; ownership is enforced server-side.
 */
export async function verifyAuthSuccessConnection(args: {
  platform: string;
  connectionId: string;
  signal?: AbortSignal;
}): Promise<
  | {
      ok: true;
      platform: string;
      platformDisplay: string;
      connectionId: string;
    }
  | { ok: false; reason: "rejected" }
> {
  try {
    const data = await api<{
      connection?: { id?: string; platform?: string; status?: string };
    }>(`/api/v1/oauth/connections/${encodeURIComponent(args.connectionId)}`, {
      signal: args.signal,
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
    const status =
      typeof connection.status === "string"
        ? connection.status.trim().toLowerCase()
        : "active";
    if (status && status !== "active" && status !== "connected") {
      return { ok: false, reason: "rejected" };
    }
    return {
      ok: true,
      platform: args.platform,
      platformDisplay: PLATFORM_NAMES[args.platform] ?? args.platform,
      connectionId: args.connectionId,
    };
  } catch (error) {
    if (error instanceof ApiError) {
      return { ok: false, reason: "rejected" };
    }
    if (error instanceof DOMException && error.name === "AbortError") {
      throw error;
    }
    return { ok: false, reason: "rejected" };
  }
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
    void verifyAuthSuccessConnection({
      platform: candidate.platform,
      connectionId: candidate.connectionId,
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
        setView({ phase: "unverified", reason: "rejected" });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (error instanceof DOMException && error.name === "AbortError")
          return;
        setView({ phase: "unverified", reason: "rejected" });
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
