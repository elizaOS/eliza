/**
 * OAuth/connector auth-success callback page (public). Shows a connection-
 * successful card and auto-closes the popup.
 */

import { CheckCircle } from "lucide-react";
import { useEffect } from "react";
import { useSearchParams } from "react-router-dom";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

const platformNames: Record<string, string> = {
  google: "Google",
  linear: "Linear",
  notion: "Notion",
  github: "GitHub",
  slack: "Slack",
  twitter: "Twitter",
  discord: "Discord",
};

function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

export default function AuthSuccessPage() {
  const t = useCloudT();
  const [searchParams] = useSearchParams();

  usePageTitle(
    t("cloud.authSuccess.metaTitle", {
      defaultValue: "Connection Successful | Eliza Cloud",
    }),
  );

  const platform =
    searchParams.get("platform") ||
    Array.from(searchParams.keys())
      .find((k) => k.endsWith("_connected"))
      ?.replace("_connected", "") ||
    null;

  const platformDisplay = platform
    ? platformNames[platform.toLowerCase()] || capitalize(platform)
    : null;

  useEffect(() => {
    if (!window.opener || window.opener.closed) return;
    const timer = setTimeout(() => {
      window.close();
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="theme-cloud relative flex min-h-[100dvh] items-center justify-center bg-bg p-4">
      <div className="relative w-full max-w-md bg-card border border-border p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center bg-status-success-bg">
            <CheckCircle className="h-7 w-7 text-status-success" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-txt">
              {platformDisplay
                ? t("cloud.authSuccess.platformConnected", {
                    platform: platformDisplay,
                    defaultValue: "{{platform}} Connected",
                  })
                : t("cloud.authSuccess.connectionSuccessful", {
                    defaultValue: "Connection Successful",
                  })}
            </h2>
            <p className="text-sm text-muted">
              {platformDisplay
                ? t("cloud.authSuccess.platformAccountConnected", {
                    platform: platformDisplay,
                    defaultValue:
                      "Your {{platform}} account has been connected successfully.",
                  })
                : t("cloud.authSuccess.accountConnected", {
                    defaultValue:
                      "Your account has been connected successfully.",
                  })}
            </p>
          </div>

          <p className="text-xs text-muted">
            {t("cloud.authSuccess.returnToApp", {
              defaultValue: "Return to the app to continue.",
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
