/**
 * OAuth/connector auth-success callback page (public). Renders success only
 * when the URL carries a completion marker for a known OAuth provider id;
 * otherwise shows an explicit unverified state with recovery CTAs.
 *
 * This is a presentation gate, not cryptographic proof: query params remain
 * client-visible. Naked and unknown-platform URLs must never claim success.
 */

import { AlertCircle, CheckCircle, Home, RefreshCw } from "lucide-react";
import { useEffect } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/primitives";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

/**
 * Display names for every provider id the cloud OAuth callback may emit on
 * `/auth/success` (aligned with `OAUTH_PROVIDERS` plus connector-native
 * Discord). Unknown values must never become a trust signal on this route.
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

export type AuthSuccessSignal =
  | {
      kind: "verified";
      platform: string;
      platformDisplay: string;
      connectionId: string | null;
    }
  | {
      kind: "unverified";
      reason: "missing" | "untrusted";
    };

/**
 * Parse the callback query into a verified completion signal or an explicit
 * unverified reason. Real OAuth callbacks append
 * `{platform}_connected=true&platform={platform}&connection_id=…`.
 */
export function resolveAuthSuccessSignal(
  searchParams: URLSearchParams,
): AuthSuccessSignal {
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

  // Require a backend-issued marker. A bare `?platform=google` (or any
  // attacker-chosen platform label) must not claim success.
  const hasConnectedFlag = connectedPlatform === platform;
  if (!hasConnectedFlag && !connectionId) {
    return { kind: "unverified", reason: "untrusted" };
  }

  // connection_id without a matching known platform was already rejected.
  // connection_id with a known platform but no *_connected flag is accepted
  // because some backend-issued handoffs only mint the id + platform pair.
  return {
    kind: "verified",
    platform,
    platformDisplay: PLATFORM_NAMES[platform],
    connectionId,
  };
}

export default function AuthSuccessPage() {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const signal = resolveAuthSuccessSignal(searchParams);
  const verified = signal.kind === "verified";

  usePageTitle(
    verified
      ? t("cloud.authSuccess.metaTitle", {
          defaultValue: "Connection Successful | Eliza Cloud",
        })
      : t("cloud.authSuccess.unverifiedMetaTitle", {
          defaultValue: "Connection Could Not Be Verified | Eliza Cloud",
        }),
  );

  useEffect(() => {
    if (!verified) return;
    if (!window.opener || window.opener.closed) return;
    const timer = setTimeout(() => {
      window.close();
    }, 2000);

    return () => clearTimeout(timer);
  }, [verified]);

  if (!verified) {
    const description =
      signal.reason === "untrusted"
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

  const { platformDisplay } = signal;

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
