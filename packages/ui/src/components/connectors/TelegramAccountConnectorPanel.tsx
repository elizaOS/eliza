/**
 * Setup panel for the Telegram user-account (MTProto) connector, as opposed to
 * the bot connector. Drives the phone-number/login-code pairing flow against
 * the API client and shows the linked account's handle/name once connected.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { client } from "../../api";
import { useAppSelector } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Card } from "../ui/card";
import { Input } from "../ui/input";

type TelegramAccountStatus = Awaited<
  ReturnType<typeof client.getTelegramAccountStatus>
>;

function accountLabel(status: TelegramAccountStatus | null): string | null {
  const account = status?.detail.account;
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
  switch (status?.detail.status) {
    case "waiting_for_provisioning_code":
      return {
        label: "Telegram app provisioning code",
        placeholder:
          "Code from Telegram after the my.telegram.org login prompt",
        field: "provisioningCode",
      };
    case "waiting_for_telegram_code":
      return {
        label: status.detail.isCodeViaApp
          ? "Telegram app login code"
          : "Telegram SMS login code",
        placeholder: status.detail.isCodeViaApp
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
  const t = useAppSelector((s) => s.t);
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
      setPhone((current) => current || nextStatus.detail.phone || "");
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
    if (!trimmedPhone && !(status?.detail.phone ?? "").trim()) {
      setError("Telegram phone number is required.");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const nextStatus = await client.startTelegramAccountAuth(trimmedPhone);
      setStatus(nextStatus);
      setPhone(nextStatus.detail.phone ?? trimmedPhone);
      setInputValue("");
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setSubmitting(false);
    }
  }, [phone, status?.detail.phone]);

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
      tone={error || status?.detail.status === "error" ? "danger" : "default"}
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
          <Card
            border="subtle"
            surface="backgroundSubtle"
            padding="compact"
            tone="mutedStrong"
            className="text-xs-tight"
          >
            {status?.detail.serviceConnected
              ? `Connected as ${connectedLabel}.`
              : `Authenticated as ${connectedLabel}.`}
          </Card>
        ) : null}

        {status?.detail.status === "idle" ||
        status?.detail.status === "error" ? (
          <div className="space-y-2">
            <Input
              type="tel"
              variant="config"
              density="compact"
              value={phone}
              onChange={(event) => {
                setPhone(event.target.value);
                if (error) {
                  setError(null);
                }
              }}
              placeholder="+15551234567"
            />
            <Button
              variant="default"
              size="sm"
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
              <Input
                type={prompt.field === "password" ? "password" : "text"}
                variant="config"
                density="compact"
                value={inputValue}
                onChange={(event) => {
                  setInputValue(event.target.value);
                  if (error) {
                    setError(null);
                  }
                }}
                placeholder={prompt.placeholder}
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    void submitAuthInput();
                  }
                }}
              />
              <Button
                variant="default"
                size="sm"
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

        {status?.detail.restartRequired ? (
          <Card
            border="subtle"
            surface="backgroundSubtle"
            padding="compact"
            tone="mutedStrong"
            stack="compact"
            className="text-xs-tight"
          >
            <div>
              {t("pluginsview.TelegramAccountRestartHint", {
                defaultValue:
                  "Telegram authentication is saved locally. Restart the agent to bring the connector online.",
              })}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void restartAgent();
              }}
              disabled={restarting}
            >
              {restarting
                ? t("common.restarting", { defaultValue: "Restarting\u2026" })
                : t("common.restart", { defaultValue: "Restart agent" })}
            </Button>
          </Card>
        ) : null}

        {status?.detail.status !== "idle" ? (
          <Button
            variant="outline"
            size="sm"
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

        {status?.detail.status === "waiting_for_provisioning_code" ? (
          <div className="text-muted">
            {t("pluginsview.TelegramAccountProvisioningExplain", {
              defaultValue:
                "Telegram first asks the app to provision credentials through my.telegram.org. Enter the code Telegram sent you there, then the app will request the normal account login code.",
            })}
          </div>
        ) : null}

        {status?.detail.status === "waiting_for_telegram_code" ? (
          <div className="text-muted">
            {status.detail.isCodeViaApp
              ? "Enter the login code that Telegram sent inside your Telegram app."
              : "Enter the login code that Telegram sent by SMS."}
          </div>
        ) : null}

        {status?.detail.status === "waiting_for_password" ? (
          <div className="text-muted">
            Enter your Telegram two-factor password to finish linking this
            account.
          </div>
        ) : null}

        {error || status?.detail.error ? (
          <div className="text-danger">{error ?? status?.detail.error}</div>
        ) : null}
      </div>
    </PagePanel.Notice>
  );
}
