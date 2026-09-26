/**
 * Setup panel for the Telegram bot connector: takes a bot token, validates it
 * against the API client (which resolves the bot's identity), and reports the
 * saved, connected, and unfinished-disconnect states across remounts.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { client } from "../../api";
import { useAppSelector } from "../../state";
import { PagePanel } from "../composites/page-panel";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { TextLink } from "../ui/text-link";

type TelegramSetupStatus =
  | "loading"
  | "idle"
  | "validating"
  | "connected"
  | "error";

type BotInfo = {
  id: number;
  username: string;
  firstName: string;
};

type TelegramStatusResponse = {
  connector: "telegram";
  state: "idle" | "configuring" | "paired" | "error";
  detail?: {
    bot?: BotInfo;
    hasToken?: boolean;
    serviceConnected?: boolean;
    credentialRetained?: boolean;
    disconnectPending?: boolean;
  };
};

type SetupErrorBody = { error?: { code?: string; message?: string } };

export function TelegramBotSetupPanel() {
  const t = useAppSelector((s) => s.t);
  const [status, setStatus] = useState<TelegramSetupStatus>("loading");
  const [disconnectNotice, setDisconnectNotice] = useState<string | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);
  const [token, setToken] = useState("");
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connectionState, setConnectionState] =
    useState<TelegramStatusResponse | null>(null);
  const [statusReadFailed, setStatusReadFailed] = useState(false);
  const [statusRefresh, setStatusRefresh] = useState(0);
  const validationInFlight = useRef(false);
  const submitBlocked =
    status === "loading" || statusReadFailed || status === "validating";

  // biome-ignore lint/correctness/useExhaustiveDependencies: Retry explicitly reloads connector status.
  useEffect(() => {
    let active = true;
    setStatus("loading");
    setStatusReadFailed(false);
    setError(null);
    void client
      .fetch("/api/setup/telegram/status")
      .then((value) => {
        if (!active) return;
        const response = value as TelegramStatusResponse;
        if (
          response.connector !== "telegram" ||
          !["idle", "configuring", "paired"].includes(response.state)
        )
          throw new Error("Telegram status is unavailable. Retry.");
        setConnectionState(response);
        const configured =
          response.detail?.hasToken ||
          response.detail?.credentialRetained ||
          response.detail?.disconnectPending;
        if (configured && !response.detail?.bot) {
          setError(
            "Bot identity unavailable. Revalidate the token before changing this connection.",
          );
          setStatus("error");
        } else if (configured && response.detail?.bot) {
          setBotInfo(response.detail.bot);
          setStatus("connected");
        } else setStatus("idle");
      })
      .catch((cause) => {
        // error-policy:J4 A failed status read remains visibly unavailable and retryable.
        if (!active) return;
        setError(
          cause instanceof Error
            ? cause.message
            : "Telegram status is unavailable. Retry.",
        );
        setStatusReadFailed(true);
        setStatus("error");
      });
    return () => {
      active = false;
    };
  }, [statusRefresh]);

  const validateAndSave = useCallback(async () => {
    if (submitBlocked || validationInFlight.current) return;
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Please paste your bot token");
      return;
    }
    validationInFlight.current = true;
    setDisconnectNotice(null);
    setStatus("validating");
    setError(null);
    try {
      const res = (await client.fetch("/api/setup/telegram/start", {
        method: "POST",
        body: JSON.stringify({ token: trimmed }),
      })) as TelegramStatusResponse & SetupErrorBody;
      if (res.error) {
        setError(res.error.message ?? "Invalid bot token");
        setStatus("error");
        return;
      }
      if (res.detail?.bot) {
        setConnectionState(res);
        setBotInfo(res.detail.bot);
        setStatus("connected");
        setToken("");
      } else {
        setError("Invalid bot token");
        setStatus("error");
      }
    } catch (nextError) {
      // error-policy:J1 Connector validation failures remain visible with the entered token intact.
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      setStatus("error");
    } finally {
      validationInFlight.current = false;
    }
  }, [token, submitBlocked]);

  const disconnect = useCallback(async () => {
    if (!botInfo) return;
    setDisconnecting(true);
    setError(null);
    try {
      const receipt = (await client.fetch("/api/setup/telegram/disconnect", {
        method: "POST",
        body: JSON.stringify({ expectedBotId: botInfo.id }),
      })) as {
        connector?: string;
        state?: string;
        accountId?: string;
        credentialRetained?: boolean;
      };
      if (
        receipt.connector !== "telegram" ||
        receipt.state !== "disconnected" ||
        receipt.accountId !== "default"
      ) {
        throw new Error(
          "Telegram disconnect is not confirmed. Refresh and retry.",
        );
      }
      setDisconnectNotice(
        receipt.credentialRetained
          ? "Bot disconnected. A saved credential remains in Vault; remove it there if no longer needed."
          : "Bot disconnected.",
      );
      if (receipt.credentialRetained) {
        setConnectionState({
          connector: "telegram",
          state: "idle",
          detail: { bot: botInfo, credentialRetained: true },
        });
      } else {
        setBotInfo(null);
        setStatus("idle");
      }
    } catch (cause) {
      // error-policy:J4 Preserve the bot identity until a terminal disconnect receipt arrives.
      setError(
        cause instanceof Error
          ? cause.message
          : "Telegram disconnect failed. Retry.",
      );
    } finally {
      setDisconnecting(false);
    }
  }, [botInfo]);

  if (status === "connected" && botInfo) {
    const pending = connectionState?.detail?.disconnectPending === true;
    const retained =
      connectionState?.state === "idle" &&
      connectionState.detail?.credentialRetained === true;
    const paired = connectionState?.state === "paired";
    return (
      <PagePanel.Notice
        tone="accent"
        className="mt-4"
        actions={
          <Button
            variant="outline"
            size="sm"
            disabled={disconnecting}
            onClick={() => {
              void disconnect();
            }}
          >
            {disconnecting
              ? "Disconnecting…"
              : pending
                ? "Retry disconnect"
                : retained
                  ? "Retry cleanup"
                  : t("common.disconnect", { defaultValue: "Disconnect" })}
          </Button>
        }
      >
        <div className="space-y-1 text-xs">
          {error ? <p role="alert">{error}</p> : null}
          <div className="font-semibold text-txt">
            {pending
              ? "Disconnect incomplete"
              : retained
                ? "Disconnected · cleanup needed"
                : paired
                  ? "Telegram connected"
                  : "Telegram saved"}
            {" \u2014 "}
            <span className="text-muted-strong">@{botInfo.username}</span>
          </div>
          {!paired ? (
            <div className="text-muted">
              {pending
                ? "Retry to finish stopping the bot."
                : retained
                  ? "Retry cleanup after unlocking Vault."
                  : "Restart to connect."}
            </div>
          ) : null}
        </div>
      </PagePanel.Notice>
    );
  }

  return (
    <>
      {disconnectNotice ? <p role="status">{disconnectNotice}</p> : null}
      {status === "loading" ? <p role="status">Checking Telegram…</p> : null}
      {statusReadFailed ? (
        <Button
          variant="outline"
          size="sm"
          onClick={() => setStatusRefresh((value) => value + 1)}
        >
          Retry status
        </Button>
      ) : null}
      <PagePanel.Notice
        tone={status === "error" ? "danger" : "default"}
        className="mt-4"
        actions={
          <Button
            variant="accentDarkHover"
            size="sm"
            onClick={() => {
              void validateAndSave();
            }}
            disabled={submitBlocked || !token.trim()}
          >
            {status === "validating"
              ? t("common.validating", { defaultValue: "Validating\u2026" })
              : t("common.connect", { defaultValue: "Connect" })}
          </Button>
        }
      >
        <div className="space-y-3 text-xs">
          <div className="space-y-1">
            <div className="font-semibold text-txt">
              {t("pluginsview.TelegramSetupTitle", {
                defaultValue: "Connect a Telegram Bot",
              })}
            </div>
            <ol className="list-inside list-decimal space-y-1 text-muted">
              <li>
                {t("common.open", {
                  defaultValue: "Open ",
                })}
                <TextLink
                  href="https://t.me/BotFather"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  @BotFather
                </TextLink>
                {t("pluginsview.TelegramStep1b", {
                  defaultValue: " on Telegram",
                })}
              </li>
              <li>
                {t("pluginsview.TelegramStep2", {
                  defaultValue:
                    "Send /newbot and follow the prompts to create your bot",
                })}
              </li>
              <li>
                {t("pluginsview.TelegramStep3", {
                  defaultValue: "Copy the bot token and paste it below",
                })}
              </li>
            </ol>
          </div>

          <Input
            type="password"
            variant="config"
            density="compact"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              if (status === "error") setStatus("idle");
            }}
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            onKeyDown={(e) => {
              if (e.key === "Enter") void validateAndSave();
            }}
          />

          {error ? <div className="text-danger">{error}</div> : null}
        </div>
      </PagePanel.Notice>
    </>
  );
}
