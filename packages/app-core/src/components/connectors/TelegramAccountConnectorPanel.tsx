import { Button, PagePanel } from "@elizaos/ui";
import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import { useApp } from "../../state";

type TelegramAccountStatus = Awaited<
  ReturnType<typeof client.getTelegramAccountStatus>
>;

function accountLabel(status: TelegramAccountStatus | null): string | null {
  const account = status?.account;
  if (!account) {
    return null;
  }
  if (account.username) {
    return `@${account.username}`;
  }
  const parts = [account.firstName, account.lastName].filter(Boolean);
  if (parts.length > 0) {
    return parts.join(" ");
  }
  return account.phone;
}

function currentPrompt(status: TelegramAccountStatus | null): {
  label: string;
  placeholder: string;
  field: "provisioningCode" | "telegramCode" | "password" | null;
} {
  switch (status?.status) {
    case "waiting_for_provisioning_code":
      return {
        label: "Telegram app provisioning code",
        placeholder:
          "Code from Telegram after the my.telegram.org login prompt",
        field: "provisioningCode",
      };
    case "waiting_for_telegram_code":
      return {
        label: status.isCodeViaApp
          ? "Telegram app login code"
          : "Telegram SMS login code",
        placeholder: status.isCodeViaApp
          ? "Code delivered inside Telegram"
          : "SMS code delivered to your phone",
        field: "telegramCode",
      };
    case "waiting_for_password":
      return {
        label: "Telegram two-factor password",
        placeholder: "Telegram account password",
        field: "password",
      };
    default:
      return {
        label: "",
        placeholder: "",
        field: null,
      };
  }
}

export function TelegramAccountConnectorPanel() {
  const { t } = useApp();
  const [status, setStatus] = useState<TelegramAccountStatus | null>(null);
  const [phone, setPhone] = useState("");
  const [inputValue, setInputValue] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const prompt = useMemo(() => currentPrompt(status), [status]);

  const refreshStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await client.getTelegramAccountStatus();
      setStatus(nextStatus);
      setPhone((current) => current || nextStatus.phone || "");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    return client.onWsEvent("ws-reconnected", () => {
      void refreshStatus();
    });
  }, [refreshStatus]);

  const startAuth = useCallback(async () => {
    const trimmedPhone = phone.trim();
    if (!trimmedPhone && !(status?.phone ?? "").trim()) {
      setError("Telegram phone number is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const nextStatus = await client.startTelegramAccountAuth(trimmedPhone);
      setStatus(nextStatus);
      setPhone(nextStatus.phone ?? trimmedPhone);
      setInputValue("");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setSubmitting(false);
    }
  }, [phone, status?.phone]);

  const submitAuthInput = useCallback(async () => {
    if (!prompt.field || !inputValue.trim()) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const payload =
        prompt.field === "password"
          ? { password: inputValue }
          : { [prompt.field]: inputValue.trim() };
      const nextStatus = await client.submitTelegramAccountAuth(payload);
      setStatus(nextStatus);
      setInputValue("");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setSubmitting(false);
    }
  }, [inputValue, prompt.field]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    setError(null);
    try {
      const nextStatus = await client.disconnectTelegramAccount();
      setStatus(nextStatus);
      setPhone("");
      setInputValue("");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setDisconnecting(false);
    }
  }, []);

  const restartAgent = useCallback(async () => {
    setRestarting(true);
    setError(null);
    try {
      await client.restartAndWait();
      await refreshStatus();
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setRestarting(false);
    }
  }, [refreshStatus]);

  const connectedLabel = accountLabel(status);

  return (
    <PagePanel.Notice
      tone={error || status?.status === "error" ? "danger" : "default"}
      className="mt-4"
    >
      <div className="space-y-3 text-xs">
        <div className="font-semibold text-txt">
          {t("pluginsview.TelegramAccountSetupTitle", {
            defaultValue: "Connect your Telegram account",
          })}
        </div>

        <div className="text-muted">
          {t("pluginsview.TelegramAccountSetupHint", {
            defaultValue:
              "This is separate from the Telegram bot connector. The app logs into Telegram as you, saves a local session, and then the Telegram account connector comes online after the agent restarts.",
          })}
        </div>

        {loading ? (
          <div className="text-muted">
            {t("common.loading", { defaultValue: "Loading\u2026" })}
          </div>
        ) : null}

        {connectedLabel ? (
          <div className="rounded-lg border border-border/40 bg-bg/60 px-3 py-2 text-xs-tight text-muted-strong">
            {status?.serviceConnected
              ? `Connected as ${connectedLabel}.`
              : `Authenticated as ${connectedLabel}.`}
          </div>
        ) : null}

        {status?.status === "idle" || status?.status === "error" ? (
          <div className="space-y-2">
            <input
              type="tel"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
              placeholder="+15551234567"
              className="h-8 w-full rounded-lg border border-border/50 bg-bg/70 px-3 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent focus:outline-none"
            />
            <Button
              variant="default"
              size="sm"
              className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
              onClick={() => {
                void startAuth();
              }}
              disabled={submitting}
            >
              {submitting
                ? t("common.connecting", { defaultValue: "Starting\u2026" })
                : t("common.connect", { defaultValue: "Connect" })}
            </Button>
          </div>
        ) : null}

        {prompt.field ? (
          <div className="space-y-2">
            <div className="text-muted">{prompt.label}</div>
            <div className="flex items-center gap-2">
              <input
                type={prompt.field === "password" ? "password" : "text"}
                value={inputValue}
                onChange={(event) => {
                  setInputValue(event.target.value);
                  if (error) {
                    setError(null);
                  }
                }}
                placeholder={prompt.placeholder}
                className="h-8 flex-1 rounded-lg border border-border/50 bg-bg/70 px-3 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent focus:outline-none"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void submitAuthInput();
                  }
                }}
              />
              <Button
                variant="default"
                size="sm"
                className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
                onClick={() => {
                  void submitAuthInput();
                }}
                disabled={submitting || !inputValue.trim()}
              >
                {submitting
                  ? t("common.submitting", { defaultValue: "Submitting\u2026" })
                  : t("common.continue", { defaultValue: "Continue" })}
              </Button>
            </div>
          </div>
        ) : null}

        {status?.restartRequired ? (
          <div className="space-y-2 rounded-lg border border-border/40 bg-bg/60 px-3 py-2 text-xs-tight text-muted-strong">
            <div>
              {t("pluginsview.TelegramAccountRestartHint", {
                defaultValue:
                  "Telegram authentication is saved locally. Restart the agent to bring the connector online.",
              })}
            </div>
            <Button
              variant="outline"
              size="sm"
              className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
              onClick={() => {
                void restartAgent();
              }}
              disabled={restarting}
            >
              {restarting
                ? t("common.restarting", { defaultValue: "Restarting\u2026" })
                : t("common.restart", { defaultValue: "Restart agent" })}
            </Button>
          </div>
        ) : null}

        {status?.status !== "idle" ? (
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
            onClick={() => {
              void disconnect();
            }}
            disabled={disconnecting}
          >
            {disconnecting
              ? t("common.disconnecting", {
                  defaultValue: "Disconnecting\u2026",
                })
              : t("common.disconnect", { defaultValue: "Disconnect" })}
          </Button>
        ) : null}

        {status?.status === "waiting_for_provisioning_code" ? (
          <div className="text-muted">
            {t("pluginsview.TelegramAccountProvisioningExplain", {
              defaultValue:
                "Telegram first asks the app to provision credentials through my.telegram.org. Enter the code Telegram sent you there, then the app will request the normal account login code.",
            })}
          </div>
        ) : null}

        {status?.status === "waiting_for_telegram_code" ? (
          <div className="text-muted">
            {status.isCodeViaApp
              ? "Enter the login code that Telegram sent inside your Telegram app."
              : "Enter the login code that Telegram sent by SMS."}
          </div>
        ) : null}

        {status?.status === "waiting_for_password" ? (
          <div className="text-muted">
            Enter your Telegram two-factor password to finish linking this
            account.
          </div>
        ) : null}

        {error || status?.error ? (
          <div className="text-danger">{error ?? status?.error}</div>
        ) : null}
      </div>
    </PagePanel.Notice>
  );
}
