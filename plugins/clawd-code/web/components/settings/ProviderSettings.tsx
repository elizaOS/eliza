"use client";

import { useState } from "react";
import { Eye, EyeOff } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { PROVIDERS } from "@/lib/constants";
import { SettingRow, SectionHeader } from "./SettingRow";
import { cn } from "@/lib/utils";

export function ProviderSettings() {
  const { settings, updateSettings, resetSettings } = useChatStore();
  const [showKey, setShowKey] = useState(false);

  const activeProvider =
    PROVIDERS.find((p) => p.id === settings.provider) ?? PROVIDERS[0];
  const activeKey = settings.providerKeys[activeProvider.id] ?? "";

  return (
    <div>
      <SectionHeader title="Provider" onReset={() => resetSettings("provider")} />

      <SettingRow
        label="AI provider"
        description="Clawd Code defaults to Z.AI (GLM-5.2) everywhere — CLI, Telegram relay, and this UI."
      >
        <select
          value={settings.provider}
          onChange={(e) =>
            updateSettings({ provider: e.target.value as typeof settings.provider })
          }
          className={cn(
            "bg-surface-800 border border-surface-700 rounded-md px-3 py-1.5 text-sm",
            "text-surface-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
          )}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </SettingRow>

      <SettingRow
        label={activeProvider.keyLabel}
        description={`API key for ${activeProvider.label}. Stored locally, sent only to your configured API URL.`}
        stack
      >
        <div className="relative flex-1">
          <input
            type={showKey ? "text" : "password"}
            value={activeKey}
            onChange={(e) =>
              updateSettings({
                providerKeys: { ...settings.providerKeys, [activeProvider.id]: e.target.value },
              })
            }
            placeholder={activeProvider.keyPlaceholder}
            className={cn(
              "w-full bg-surface-800 border border-surface-700 rounded-md px-3 py-1.5 pr-10 text-sm",
              "text-surface-200 placeholder-surface-600 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
            )}
          />
          <button
            onClick={() => setShowKey((v) => !v)}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-surface-500 hover:text-surface-300 transition-colors"
            title={showKey ? "Hide key" : "Show key"}
          >
            {showKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
        {activeKey && (
          <p className="text-xs text-surface-500 mt-1">
            Key ending in{" "}
            <span className="font-mono text-surface-400">...{activeKey.slice(-4)}</span>
          </p>
        )}
      </SettingRow>

      <div className="mt-2 px-3 py-2 rounded-md bg-surface-800/50 border border-surface-800 text-xs text-surface-400">
        Default model for {activeProvider.label}:{" "}
        <span className="font-mono text-surface-300">{activeProvider.defaultModel}</span>
      </div>
    </div>
  );
}
