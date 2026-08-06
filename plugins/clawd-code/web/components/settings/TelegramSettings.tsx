"use client";

import { useState } from "react";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { SettingRow, SectionHeader } from "./SettingRow";
import { cn } from "@/lib/utils";

export function TelegramSettings() {
  const { settings, updateSettings, resetSettings } = useChatStore();
  const [showToken, setShowToken] = useState(false);

  const configured = Boolean(settings.telegram.botToken && settings.telegram.allowedChatId);

  return (
    <div>
      <SectionHeader title="Telegram" onReset={() => resetSettings("telegram")} />

      <div className="mb-4 flex items-start gap-2 px-3 py-2 rounded-md bg-surface-800/50 border border-surface-800 text-xs text-surface-400">
        <ShieldCheck className="w-4 h-4 flex-shrink-0 mt-0.5 text-brand-400" />
        <span>
          Chat + CLI relay only — messages route through Z.AI, no computer-use or
          OS-level control. Only the allowlisted chat id can reach the bot; the
          relay runs via <span className="font-mono text-surface-300">clawd-code telegram</span>
          {" "}on the machine hosting your bot token, not in the browser.
        </span>
      </div>

      <SettingRow
        label="Bot token"
        description="From @BotFather. Never sent to this web app's server — used only when you run the CLI relay."
        stack
      >
        <div className="relative flex-1">
          <input
            type={showToken ? "text" : "password"}
            value={settings.telegram.botToken}
            onChange={(e) =>
              updateSettings({ telegram: { ...settings.telegram, botToken: e.target.value } })
            }
            placeholder="123456:AA..."
            className={cn(
              "w-full bg-surface-800 border border-surface-700 rounded-md px-3 py-1.5 pr-10 text-sm",
              "text-surface-200 placeholder-surface-600 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
            )}
          />
          <button
            onClick={() => setShowToken((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 transition-colors"
            title={showToken ? "Hide token" : "Show token"}
          >
            {showToken ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label="Allowed chat id"
        description="Only this Telegram chat id may talk to the bot. Message the bot once, then check https://api.telegram.org/bot<token>/getUpdates to find it."
        stack
      >
        <input
          type="text"
          value={settings.telegram.allowedChatId}
          onChange={(e) =>
            updateSettings({ telegram: { ...settings.telegram, allowedChatId: e.target.value } })
          }
          placeholder="123456789"
          className={cn(
            "w-full bg-surface-800 border border-surface-700 rounded-md px-3 py-1.5 text-sm",
            "text-surface-200 placeholder-surface-600 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
          )}
        />
      </SettingRow>

      <SettingRow label="Status" description="Whether both values needed to start the relay are set.">
        <span
          className={cn(
            "text-xs px-2 py-1 rounded-md border",
            configured
              ? "text-green-400 border-green-900 bg-green-950/30"
              : "text-surface-500 border-surface-800 bg-surface-800/50"
          )}
        >
          {configured ? "Ready" : "Incomplete"}
        </span>
      </SettingRow>

      <div className="mt-2 px-3 py-2 rounded-md bg-surface-800/50 border border-surface-800 text-xs text-surface-400">
        Start the relay:
        <pre className="mt-1 font-mono text-surface-300 whitespace-pre-wrap break-all">
          TELEGRAM_BOT_TOKEN={settings.telegram.botToken || "<token>"}{"\n"}
          TELEGRAM_ALLOWED_CHAT_ID={settings.telegram.allowedChatId || "<chat-id>"}{"\n"}
          clawd-code telegram
        </pre>
      </div>
    </div>
  );
}
