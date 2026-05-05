import { Button, PagePanel } from "@elizaos/ui";
import { useCallback, useState } from "react";
import { client } from "../../api";
import { useApp } from "../../state";

type TelegramSetupStatus = "idle" | "validating" | "connected" | "error";

type BotInfo = {
  id: number;
  username: string;
  firstName: string;
};

export function TelegramBotSetupPanel() {
  const { t } = useApp();
  const [status, setStatus] = useState<TelegramSetupStatus>("idle");
  const [token, setToken] = useState("");
  const [botInfo, setBotInfo] = useState<BotInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const validateAndSave = useCallback(async () => {
    const trimmed = token.trim();
    if (!trimmed) {
      setError("Please paste your bot token");
      return;
    }
    setStatus("validating");
    setError(null);
    try {
      const res = (await client.fetch("/api/telegram-setup/validate-token", {
        method: "POST",
        body: JSON.stringify({ token: trimmed }),
      })) as {
        ok: boolean;
        bot?: BotInfo;
        error?: string;
      };
      if (res.ok && res.bot) {
        setBotInfo(res.bot);
        setStatus("connected");
        setToken("");
      } else {
        setError(res.error ?? "Invalid bot token");
        setStatus("error");
      }
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      setStatus("error");
    }
  }, [token]);

  const disconnect = useCallback(async () => {
    try {
      await client.fetch("/api/telegram-setup/disconnect", { method: "POST" });
      setBotInfo(null);
      setStatus("idle");
    } catch {
      // ignore
    }
  }, []);

  if (status === "connected" && botInfo) {
    return (
      <PagePanel.Notice tone="accent" className="mt-4">
        <div className="space-y-2 text-xs">
          <div className="font-semibold text-txt">
            {t("pluginsview.TelegramConnected", {
              defaultValue: "Telegram bot connected",
            })}
            {" \u2014 "}
            <span className="text-muted-strong">@{botInfo.username}</span>
          </div>
          <div className="text-muted">
            {t("pluginsview.TelegramConnectedHint", {
              defaultValue:
                "Your bot is saved and will auto-connect on next start. Enable the Telegram plugin above if it isn't already active.",
            })}
          </div>
          <Button
            variant="outline"
            size="sm"
            className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
            onClick={() => {
              void disconnect();
            }}
          >
            {t("common.disconnect", { defaultValue: "Disconnect" })}
          </Button>
        </div>
      </PagePanel.Notice>
    );
  }

  return (
    <PagePanel.Notice
      tone={status === "error" ? "danger" : "default"}
      className="mt-4"
    >
      <div className="space-y-3 text-xs">
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
            <a
              href="https://t.me/BotFather"
              target="_blank"
              rel="noopener noreferrer"
              className="font-medium text-accent underline"
            >
              @BotFather
            </a>
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

        <div className="flex items-center gap-2">
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              if (status === "error") setStatus("idle");
            }}
            placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
            className="h-8 flex-1 rounded-lg border border-border/50 bg-bg/70 px-3 text-xs-tight text-txt placeholder:text-muted/50 focus:border-accent focus:outline-none"
            onKeyDown={(e) => {
              if (e.key === "Enter") void validateAndSave();
            }}
          />
          <Button
            variant="default"
            size="sm"
            className="h-8 rounded-xl px-4 text-xs-tight font-semibold"
            onClick={() => {
              void validateAndSave();
            }}
            disabled={status === "validating" || !token.trim()}
          >
            {status === "validating"
              ? t("common.validating", { defaultValue: "Validating\u2026" })
              : t("common.connect", { defaultValue: "Connect" })}
          </Button>
        </div>

        {error ? <div className="text-danger">{error}</div> : null}
      </div>
    </PagePanel.Notice>
  );
}
