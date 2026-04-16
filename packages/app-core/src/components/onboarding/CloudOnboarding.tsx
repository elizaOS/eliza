
import { useEffect } from "react";
import { useApp } from "../../state";
import { openExternalUrl } from "../../utils";
import { Button } from "@elizaos/ui";

/**
 * Minimal onboarding screen for Eliza Home.
 * Shows a single step: connect to Eliza Cloud.
 * Once connected, automatically completes onboarding and navigates to chat.
 */
export function CloudOnboarding() {
  const {
    elizaCloudConnected,
    elizaCloudLoginBusy,
    elizaCloudLoginError,
    handleCloudLogin,
    handleCloudOnboardingFinish,
    t,
  } = useApp();

  // Auto-complete onboarding once cloud is connected.
  useEffect(() => {
    if (elizaCloudConnected) {
      void handleCloudOnboardingFinish();
    }
  }, [elizaCloudConnected, handleCloudOnboardingFinish]);

  const urlMatch = elizaCloudLoginError?.match(
    /^Open this link to log in: (.+)$/,
  );

  return (
    <div className="flex items-center justify-center min-h-screen bg-bg text-txt font-body">
      <div className="flex flex-col items-center gap-6 max-w-md w-full px-6">
        {/* Logo */}
        <div className="flex flex-col items-center gap-2 mb-2">
          <div className="text-4xl font-bold tracking-tight">eliza</div>
          <p className="text-muted text-sm text-center">
            {t("cloudonboarding.ConnectToElizaCloud", {
              defaultValue: "Sign in to get started",
            })}
          </p>
        </div>

        {/* Main card */}
        <div className="w-full rounded-xl border border-border bg-surface p-6 flex flex-col items-center gap-4">
          {elizaCloudConnected ? (
            <p className="text-ok text-sm">
              {t("cloudonboarding.ConnectedSetupAgent", {
                defaultValue: "Connected! Setting up your agent...",
              })}
            </p>
          ) : (
            <>
              <Button
                variant="default"
                className="w-full py-3 px-4 rounded-lg bg-accent text-accent-fg font-medium text-sm hover:opacity-90 transition-opacity disabled:opacity-50"
                onClick={() => { void handleCloudLogin(); }}
                disabled={elizaCloudLoginBusy}
              >
                {elizaCloudLoginBusy
                  ? t("cloudonboarding.WaitingForLogin", {
                      defaultValue: "Waiting for login...",
                    })
                  : t("cloudonboarding.ConnectButton", {
                      defaultValue: "Connect to Eliza Cloud",
                    })}
              </Button>

              {elizaCloudLoginError && (
                <div className="w-full text-sm text-center">
                  {urlMatch ? (
                    <Button
                      variant="link"
                      className="text-accent underline"
                      onClick={() => void openExternalUrl(urlMatch[1])}
                    >
                      {t("cloudonboarding.ClickToOpenLogin", {
                        defaultValue: "Open login page",
                      })}
                    </Button>
                  ) : (
                    <p className="text-err">{elizaCloudLoginError}</p>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
