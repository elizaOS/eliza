/**
 * Authentication error page (public). Maps a `?reason=` query to a friendly
 * message and offers retry / home.
 */

import { AlertCircle, Home, RefreshCw } from "lucide-react";
import { useEffect, useRef } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/primitives";
import { appModeNavigation } from "../../../app-mode/app-mode";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { pairedAppLoginUrlForMintHost } from "../../../sso-bridge/sso-bridge";
import { resolveLoginReturnTo } from "../../lib/login-return-to";
import { usePageTitle } from "../../lib/use-page-title";
import { AuthResultShell } from "./auth-result-shell";

export function AuthErrorPageForHost({
  hostname,
}: {
  /** Injectable for the mint-host recovery composition test. */
  hostname: string;
}) {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reason = searchParams.get("reason") || "unknown";
  const returnTo = resolveLoginReturnTo(searchParams);
  const localLoginUrl = `/login?returnTo=${encodeURIComponent(returnTo)}`;
  const pairedAppLoginUrl = pairedAppLoginUrlForMintHost(hostname, returnTo);
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    // A client-side route change does not move screen-reader focus on its own.
    // Focus the recovery heading so the unexpected failure and next action are
    // announced immediately without adding an assertive live-region duplicate.
    if (reason) headingRef.current?.focus({ preventScroll: true });
  }, [reason]);

  usePageTitle(
    t("cloud.authError.metaTitle", {
      defaultValue: "Authentication Error | Eliza Cloud",
    }),
  );

  const errorMessages: Record<string, { title: string; description: string }> =
    {
      auth_failed: {
        title: t("cloud.authError.authFailedTitle", {
          defaultValue: "Authentication Failed",
        }),
        description: t("cloud.authError.authFailedDescription", {
          defaultValue:
            "We could not authenticate your account. Please try signing in again.",
        }),
      },
      sync_failed: {
        title: t("cloud.authError.syncFailedTitle", {
          defaultValue: "Authentication Sync Failed",
        }),
        description: t("cloud.authError.syncFailedDescription", {
          defaultValue:
            "We could not sync your account information. Please try signing in again.",
        }),
      },
      unknown: {
        title: t("cloud.authError.unknownTitle", {
          defaultValue: "Authentication Error",
        }),
        description: t("cloud.authError.unknownDescription", {
          defaultValue:
            "An unexpected error occurred during authentication. Please try again.",
        }),
      },
    };

  const error = errorMessages[reason] || errorMessages.unknown;

  return (
    <AuthResultShell>
      <div className="flex size-14 items-center justify-center bg-destructive-subtle">
        <AlertCircle className="size-7 text-destructive" aria-hidden="true" />
      </div>
      <div className="space-y-2">
        <h1
          ref={headingRef}
          tabIndex={-1}
          className="text-xl font-semibold text-txt outline-none"
        >
          {error.title}
        </h1>
        <p className="text-sm text-muted">{error.description}</p>
      </div>

      <div className="w-full space-y-3">
        <Button
          onClick={() => {
            if (pairedAppLoginUrl) {
              appModeNavigation.replace(pairedAppLoginUrl);
              return;
            }
            navigate(localLoginUrl);
          }}
          className="hosted-signin-focus-emphasis h-11 w-full bg-accent text-accent-foreground hover:bg-accent-hover"
        >
          <RefreshCw className="mr-2 size-4" aria-hidden="true" />
          {t("cloud.authError.tryAgain", { defaultValue: "Try Again" })}
        </Button>
        <Button
          variant="outline"
          asChild
          className="hosted-signin-focus-emphasis h-11 w-full border-border hover:bg-bg-hover"
        >
          <Link to="/">
            <Home className="mr-2 size-4" aria-hidden="true" />
            {t("cloud.authError.goHome", { defaultValue: "Go Home" })}
          </Link>
        </Button>
      </div>

      <p className="text-xs text-muted">
        {t("cloud.authError.contactSupport", {
          defaultValue: "If this problem persists, please contact support.",
        })}
      </p>
    </AuthResultShell>
  );
}

export default function AuthErrorPage() {
  const hostname =
    typeof window === "undefined" ? "" : window.location.hostname;
  return <AuthErrorPageForHost hostname={hostname} />;
}
