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
import {
  CalendarDays,
  Check,
  Loader2,
  MessageCircle,
  SkipForward,
} from "lucide-react";
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

function SetupStatusPip({
  connected,
  loading,
  label,
}: {
  connected: boolean;
  loading?: boolean;
  label: string;
}) {
  return (
    <span
      className={[
        "inline-flex h-5 w-5 items-center justify-center rounded-full border",
        connected
          ? "border-ok/45 bg-ok/12 text-ok"
          : "border-border/30 bg-bg/45 text-muted",
      ].join(" ")}
      title={label}
      aria-label={label}
    >
      {loading ? (
        <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
      ) : connected ? (
        <Check className="h-3 w-3" aria-hidden />
      ) : (
        <span className="h-1.5 w-1.5 rounded-full bg-current opacity-70" />
      )}
    </span>
  );
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
    () => Intl.DateTimeFormat().resolvedOptions().timeZone,
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
    <div className="space-y-5 px-1 py-2" data-testid="lifeops-setup-gate">
      <div className="space-y-4">
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label
              htmlFor="lifeops-setup-name"
              className="sr-only"
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
              className="sr-only"
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
          <div className="grid gap-3 sm:grid-cols-2">
            <button
              type="button"
              onClick={handleConnectCalendar}
              disabled={ownerConnector.actionPending}
              className={[
                "flex min-h-16 items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                calendarConnected
                  ? "border-ok/40 bg-ok/8 text-txt"
                  : "border-border/16 bg-card/18 hover:bg-card/30 text-txt",
              ].join(" ")}
            >
              <div className="flex min-w-0 items-center gap-3">
                <CalendarDays className="h-4 w-4 shrink-0 text-muted" />
                <div className="truncate text-sm font-medium">
                  {t("lifeopssetup.calendarTitle", {
                    defaultValue: "Google Calendar",
                  })}
                </div>
              </div>
              <SetupStatusPip
                connected={calendarConnected}
                loading={ownerConnector.actionPending}
                label={
                  calendarConnected
                    ? t("lifeopssetup.connected", {
                        defaultValue: "Connected",
                      })
                    : t("lifeopssetup.calendarTitle", {
                        defaultValue: "Google Calendar",
                      })
                }
              />
            </button>

            <button
              type="button"
              onClick={handleConnectX}
              disabled={xConnector.actionPending}
              className={[
                "flex min-h-16 items-center justify-between gap-3 rounded-2xl border px-4 py-3 text-left transition-colors",
                xConnected
                  ? "border-ok/40 bg-ok/8 text-txt"
                  : "border-border/16 bg-card/18 hover:bg-card/30 text-txt",
              ].join(" ")}
            >
              <div className="flex min-w-0 items-center gap-3">
                <MessageCircle className="h-4 w-4 shrink-0 text-muted" />
                <div className="truncate text-sm font-medium">
                  {t("lifeopssetup.messagingTitle", {
                    defaultValue: "X DMs",
                  })}
                </div>
              </div>
              <SetupStatusPip
                connected={xConnected}
                loading={xConnector.actionPending}
                label={
                  xConnected
                    ? t("lifeopssetup.connected", {
                        defaultValue: "Connected",
                      })
                    : t("lifeopssetup.messagingTitle", {
                        defaultValue: "X DMs",
                      })
                }
              />
            </button>
          </div>

          {!calendarConnected && !xConnected && !skipped ? (
            <button
              type="button"
              onClick={handleSkip}
              className="inline-flex h-8 w-8 items-center justify-center rounded-xl text-muted hover:bg-bg-hover/40 hover:text-txt"
              aria-label={t("lifeopssetup.skipProviders", {
                defaultValue: "Skip for now",
              })}
              title={t("lifeopssetup.skipProviders", {
                defaultValue: "Skip for now",
              })}
            >
              <SkipForward className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>
      </div>

      <div className="flex items-center gap-3 pt-1">
        <Button
          size="sm"
          disabled={!canContinue}
          onClick={onDismiss}
          className="h-9 w-9 rounded-full p-0"
          aria-label={t("lifeopssetup.continue", {
            defaultValue: "Continue",
          })}
          title={
            canContinue
              ? t("lifeopssetup.continue", {
                  defaultValue: "Continue",
                })
              : t("lifeopssetup.continueHint", {
                  defaultValue: "Fill in your name and timezone to continue.",
                })
          }
        >
          <Check className="h-4 w-4" aria-hidden />
        </Button>
        {!canContinue ? (
          <SetupStatusPip
            connected={false}
            label={t("lifeopssetup.continueHint", {
              defaultValue: "Fill in your name and timezone to continue.",
            })}
          />
        ) : null}
      </div>
    </div>
  );
}
