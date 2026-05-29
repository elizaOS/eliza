import { CheckCircle, Loader2, MessageCircle } from "lucide-react";
import { Suspense, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { useSearchParams } from "react-router-dom";
import { useT } from "@/providers/I18nProvider";

// Platform display names
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

function AuthSuccessContent() {
  const t = useT();
  const [canClose, setCanClose] = useState(false);
  const [searchParams] = useSearchParams();

  // Get platform from URL params (e.g., ?platform=linear or ?google_connected=true)
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
    // Try to close the window after a short delay
    // This works when the page was opened via window.open()
    const timer = setTimeout(() => {
      try {
        window.close();
      } catch {
        // If we can't close, show the manual close message
        setCanClose(true);
      }
      // If window.close() didn't work (opened in new tab), show message
      setCanClose(true);
    }, 2000);

    return () => clearTimeout(timer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-black p-4">
      <div className="absolute inset-0 bg-black" />
      <div className="relative w-full max-w-md bg-black border border-white/14 p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <div className="flex h-14 w-14 items-center justify-center  bg-green-500/10">
            <CheckCircle className="h-7 w-7 text-green-500" />
          </div>
          <div className="space-y-2">
            <h2 className="text-xl font-semibold text-white">
              {platformDisplay
                ? t("cloud.authSuccess.platformConnected", {
                    platform: platformDisplay,
                    defaultValue: "{{platform}} Connected",
                  })
                : t("cloud.authSuccess.connectionSuccessful", {
                    defaultValue: "Connection Successful",
                  })}
            </h2>
            <p className="text-sm text-neutral-400">
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

          <div className="w-full p-4 bg-white/[0.04]  border border-white/14">
            <div className="flex items-center gap-3 text-left">
              <MessageCircle className="h-5 w-5 text-neutral-400 flex-shrink-0" />
              <p className="text-sm text-neutral-300">
                {t("cloud.authSuccess.returnPrefix", {
                  defaultValue: "Return to your chat and say",
                })}{" "}
                <span className="text-white font-medium">
                  {t("cloud.authSuccess.doneWord", { defaultValue: '"done"' })}
                </span>{" "}
                {t("cloud.authSuccess.returnSuffix", {
                  defaultValue: "to verify the connection.",
                })}
              </p>
            </div>
          </div>

          {canClose && (
            <p className="text-xs text-neutral-600">
              {t("cloud.authSuccess.canClose", {
                defaultValue: "You can close this window.",
              })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function LoadingFallback() {
  const t = useT();
  return (
    <div className="flex min-h-screen items-center justify-center bg-black p-4">
      <div className="absolute inset-0 bg-black" />
      <div className="relative w-full max-w-md bg-black border border-white/14 p-8">
        <div className="flex flex-col items-center gap-6 text-center">
          <Loader2 className="h-8 w-8 text-neutral-400 animate-spin" />
          <p className="text-sm text-neutral-400">
            {t("cloud.authSuccess.loading", { defaultValue: "Loading..." })}
          </p>
        </div>
      </div>
    </div>
  );
}

export default function AuthSuccessPage() {
  const t = useT();
  return (
    <>
      <Helmet>
        <title>
          {t("cloud.authSuccess.metaTitle", {
            defaultValue: "Connection Successful | Eliza Cloud",
          })}
        </title>
      </Helmet>
      <Suspense fallback={<LoadingFallback />}>
        <AuthSuccessContent />
      </Suspense>
    </>
  );
}
