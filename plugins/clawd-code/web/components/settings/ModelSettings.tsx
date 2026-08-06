"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { MODELS } from "@/lib/constants";
import { SettingRow, SectionHeader, Slider } from "./SettingRow";
import { cn } from "@/lib/utils";

export function ModelSettings() {
  const { settings, updateSettings, resetSettings } = useChatStore();
  const [showAdvanced, setShowAdvanced] = useState(false);

  const selectedModel = MODELS.find((m) => m.id === settings.model);

  return (
    <div>
      <SectionHeader title="Model" onReset={() => resetSettings("model")} />

      <SettingRow
        label="Default model"
        description="The AI model used for new conversations."
      >
        <select
          value={settings.model}
          onChange={(e) => updateSettings({ model: e.target.value })}
          className={cn(
            "bg-surface-800 border border-surface-700 rounded-md px-3 py-1.5 text-sm",
            "text-surface-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
          )}
        >
          {MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label} — {m.description}
            </option>
          ))}
        </select>
      </SettingRow>

      {selectedModel && (
        <div className="mb-4 px-3 py-2 rounded-md bg-surface-800/50 border border-surface-800 text-xs text-surface-400">
          <span className="font-medium text-surface-300">{selectedModel.label}</span>
          {" — "}{selectedModel.description}
        </div>
      )}

      <SettingRow
        label="Max tokens"
        description="Maximum number of tokens in the model's response."
        stack
      >
        <div className="flex items-center gap-3">
          <Slider
            value={settings.maxTokens}
            min={1000}
            max={200000}
            step={1000}
            onChange={(v) => updateSettings({ maxTokens: v })}
            showValue={false}
            className="flex-1"
          />
          <input
            type="number"
            value={settings.maxTokens}
            min={1000}
            max={200000}
            step={1000}
            onChange={(e) => updateSettings({ maxTokens: Number(e.target.value) })}
            className={cn(
              "w-24 bg-surface-800 border border-surface-700 rounded-md px-2 py-1 text-sm text-right",
              "text-surface-200 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
            )}
          />
        </div>
      </SettingRow>

      <SettingRow
        label="System prompt"
        description="Custom instructions prepended to every conversation."
        stack
      >
        <textarea
          value={settings.systemPrompt}
          onChange={(e) => updateSettings({ systemPrompt: e.target.value })}
          placeholder="You are a helpful assistant..."
          rows={4}
          className={cn(
            "w-full bg-surface-800 border border-surface-700 rounded-md px-3 py-2 text-sm",
            "text-surface-200 placeholder-surface-600 focus:outline-none focus:ring-1 focus:ring-brand-500",
            "resize-none font-mono"
          )}
        />
      </SettingRow>

      {/* Advanced toggle */}
      <button
        onClick={() => setShowAdvanced((v) => !v)}
        className="flex items-center gap-1.5 text-xs text-surface-400 hover:text-surface-200 transition-colors mt-2 mb-1"
      >
        <ChevronDown
          className={cn("w-3.5 h-3.5 transition-transform", showAdvanced && "rotate-180")}
        />
        Advanced settings
      </button>

      {showAdvanced && (
        <SettingRow
          label="Temperature"
          description="Controls response randomness. Higher values produce more varied output."
          stack
        >
          <Slider
            value={settings.temperature}
            min={0}
            max={1}
            step={0.05}
            onChange={(v) => updateSettings({ temperature: v })}
          />
        </SettingRow>
      )}
    </div>
  );
}
