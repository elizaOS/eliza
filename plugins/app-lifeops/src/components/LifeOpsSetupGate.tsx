/**
 * LifeOpsSetupGate — first-run setup panel.
 *
 * Replaces Dashboard content only (nav + other sections remain visible).
 * Dismissed permanently when: profile has name+timezone AND at least one of
 * {calendar provider, messaging provider, or explicit skip}.
 *
 * Dismiss flag is persisted via localStorage under
 * LIFEOPS_SETUP_GATE_DISMISSED_KEY.
 */
import { Button, dispatchFocusConnector, Input, useApp } from "@elizaos/ui";
import { CalendarDays, MessageCircle, SkipForward } from "lucide-react";
import { useCallback, useState } from "react";
import { useGoogleLifeOpsConnector } from "../hooks/useGoogleLifeOpsConnector.js";
import { useLifeOpsXConnector } from "../hooks/useLifeOpsXConnector.js";

export const LIFEOPS_SETUP_GATE_DISMISSED_KEY =
  "eliza:lifeops-setup-gate-dismissed";

function loadDismissed(): boolean {
  try {
    return localStorage.getItem(LIFEOPS_SETUP_GATE_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function saveDismissed(): void {
  try {
    localStorage.setItem(LIFEOPS_SETUP_GATE_DISMISSED_KEY, "1");
  } catch {
    // ignore
  }
}

export function clearLifeOpsSetupGateDismissed(): void {
  try {
    localStorage.removeItem(LIFEOPS_SETUP_GATE_DISMISSED_KEY);
  } catch {
    // ignore
  }
}

export function useLifeOpsSetupGate() {
  const [dismissed, setDismissed] = useState<boolean>(loadDismissed);

  const dismiss = useCallback(() => {
    saveDismissed();
    setDismissed(true);
  }, []);

  const reset = useCallback(() => {
    clearLifeOpsSetupGateDismissed();
    setDismissed(false);
  }, []);

  return { dismissed, dismiss, reset };
}

interface LifeOpsSetupGateProps {
  onDismiss: () => void;
}

export function LifeOpsSetupGate({ onDismiss }: LifeOpsSetupGateProps) {
  const { setActionNotice, setTab, t } = useApp();
  const ownerConnector = useGoogleLifeOpsConnector({
    includeAccounts: false,
    side: "owner",
  });
  const xConnector = useLifeOpsXConnector();

  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "",
  );
  const [skipped, setSkipped] = useState(false);

  const calendarConnected = ownerConnector.status?.connected === true;
  const xConnected = xConnector.status?.connected === true;

  const canContinue =
    name.trim().length > 0 &&
    timezone.trim().length > 0 &&
    (calendarConnected || xConnected || skipped);

  const handleConnectCalendar = useCallback(() => {
    void ownerConnector.connect();
  }, [ownerConnector]);

  const handleConnectX = useCallback(() => {
    if (xConnected) {
      void xConnector.refresh();
      return;
    }
    setTab("connectors");
    dispatchFocusConnector("x");
    setActionNotice(
      "X account setup is managed in Connectors. Configure plugin-x there, then refresh LifeOps.",
      "info",
      4200,
    );
  }, [setActionNotice, setTab, xConnected, xConnector]);

  const handleSkip = useCallback(() => {
    setSkipped(true);
  }, []);

  return (
    <div className="space-y-6 px-1 py-2" data-testid="lifeops-setup-gate">
      <div className="space-y-1.5">
        <h2 className="text-base font-semibold text-txt">
          {t("lifeopssetup.title", {
            defaultValue: "Set up LifeOps",
          })}
        </h2>
        <p className="text-sm leading-relaxed text-muted">
          {t("lifeopssetup.description", {
            defaultValue:
              "Tell the agent a bit about you, then connect your calendar or a messaging account to get started.",
          })}
        </p>
      </div>

      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label
              htmlFor="lifeops-setup-name"
              className="text-xs font-medium text-muted"
            >
              {t("lifeopssetup.yourName", {
                defaultValue: "Your name",
              })}
            </label>
            <Input
              id="lifeops-setup-name"
              placeholder={t("lifeopssetup.namePlaceholder", {
                defaultValue: "e.g. Alex",
              })}
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-9 rounded-xl text-sm"
            />
          </div>
          <div className="space-y-1.5">
            <label
              htmlFor="lifeops-setup-timezone"
              className="text-xs font-medium text-muted"
            >
              {t("lifeopssetup.timezone", {
                defaultValue: "Timezone",
              })}
            </label>
            <Input
              id="lifeops-setup-timezone"
              placeholder="America/New_York"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="h-9 rounded-xl text-sm"
            />
          </div>
        </div>

        <div className="space-y-2">
          <div className="text-xs font-medium text-muted">
            {t("lifeopssetup.connectProvider", {
              defaultValue: "Connect a provider (or skip for now)",
            })}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={handleConnectCalendar}
              disabled={ownerConnector.actionPending}
              className={[
                "flex items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                calendarConnected
                  ? "border-ok/40 bg-ok/8 text-txt"
                  : "border-border/16 bg-card/18 hover:bg-card/30 text-txt",
              ].join(" ")}
            >
              <CalendarDays className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="text-sm font-medium">
                  {t("lifeopssetup.calendarTitle", {
                    defaultValue: "Google Calendar",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {calendarConnected
                    ? t("lifeopssetup.connected", {
                        defaultValue: "Connected",
                      })
                    : t("lifeopssetup.calendarHint", {
                        defaultValue: "Read events, manage your schedule",
                      })}
                </div>
              </div>
            </button>

            <button
              type="button"
              onClick={handleConnectX}
              disabled={xConnector.actionPending}
              className={[
                "flex items-start gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                xConnected
                  ? "border-ok/40 bg-ok/8 text-txt"
                  : "border-border/16 bg-card/18 hover:bg-card/30 text-txt",
              ].join(" ")}
            >
              <MessageCircle className="mt-0.5 h-4 w-4 shrink-0 text-muted" />
              <div>
                <div className="text-sm font-medium">
                  {t("lifeopssetup.messagingTitle", {
                    defaultValue: "X DMs",
                  })}
                </div>
                <div className="text-xs text-muted">
                  {xConnected
                    ? t("lifeopssetup.connected", {
                        defaultValue: "Connected",
                      })
                    : t("lifeopssetup.messagingHint", {
                        defaultValue: "Read and reply to incoming DMs",
                      })}
                </div>
              </div>
            </button>
          </div>

          {!calendarConnected && !xConnected && !skipped ? (
            <button
              type="button"
              onClick={handleSkip}
              className="flex items-center gap-1.5 text-xs text-muted hover:text-txt"
            >
              <SkipForward className="h-3.5 w-3.5" />
              {t("lifeopssetup.skipProviders", {
                defaultValue: "Skip for now",
              })}
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button
          size="sm"
          disabled={!canContinue}
          onClick={onDismiss}
          className="rounded-full px-5 py-2 text-xs-tight font-semibold"
        >
          {t("lifeopssetup.continue", {
            defaultValue: "Continue",
          })}
        </Button>
        {!canContinue && (
          <span className="text-xs text-muted">
            {t("lifeopssetup.continueHint", {
              defaultValue: "Fill in your name and timezone to continue.",
            })}
          </span>
        )}
      </div>
    </div>
  );
}
