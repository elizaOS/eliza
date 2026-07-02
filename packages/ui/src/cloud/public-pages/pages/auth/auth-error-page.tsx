/**
 * Authentication error page (public). Maps a `?reason=` query to a friendly
 * message and offers retry / home.
 */

import { AlertCircle, Home, RefreshCw } from "lucide-react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { Button } from "../../../../components/primitives";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

export default function AuthErrorPage() {
  const t = useCloudT();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const reason = searchParams.get("reason") || "unknown";

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
    <div className="flex min-h-screen items-center justify-center bg-black p-4">
      <div className="absolute inset-0 bg-black" />
      <div className="relative w-full max-w-md bg-black border border-white/14 p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center bg-red-500/10">
            <AlertCircle className="h-7 w-7 text-red-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-white">{error.title}</h2>
            <p className="text-sm text-neutral-500">{error.description}</p>
          </div>

          <div className="w-full space-y-3">
            <Button
              onClick={() => navigate("/login")}
              className="w-full h-11 bg-[#FF5800] hover:bg-[#e54f00] text-white"
            >
              <RefreshCw className="h-4 w-4 mr-2" />
              {t("cloud.authError.tryAgain", { defaultValue: "Try Again" })}
            </Button>
            <Button
              variant="outline"
              asChild
              className="w-full h-11 border-white/14 hover:bg-white/10"
            >
              <Link to="/">
                <Home className="h-4 w-4 mr-2" />
                {t("cloud.authError.goHome", { defaultValue: "Go Home" })}
              </Link>
            </Button>
          </div>

          <p className="text-xs text-neutral-600">
            {t("cloud.authError.contactSupport", {
              defaultValue: "If this problem persists, please contact support.",
            })}
          </p>
        </div>
      </div>
    </div>
  );
}
