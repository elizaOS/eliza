"use client";

import { Sun, Moon, Monitor } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { useTheme } from "@/components/layout/ThemeProvider";
import { SettingRow, SectionHeader, Toggle, Slider } from "./SettingRow";
import { cn } from "@/lib/utils";

export function GeneralSettings() {
  const { settings, updateSettings, resetSettings } = useChatStore();
  const { setTheme } = useTheme();

  const themes = [
    { id: "light" as const, label: "Light", icon: Sun },
    { id: "dark" as const, label: "Dark", icon: Moon },
    { id: "system" as const, label: "System", icon: Monitor },
  ];

  function handleThemeChange(t: "light" | "dark" | "system") {
    updateSettings({ theme: t });
    setTheme(t);
  }

  return (
    <div>
      <SectionHeader title="General" onReset={() => resetSettings("general")} />

      <SettingRow
        label="Theme"
        description="Choose the color scheme for the interface."
      >
        <div className="flex gap-1.5">
          {themes.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => handleThemeChange(id)}
              className={cn(
                "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                settings.theme === id
                  ? "bg-brand-600 text-white"
                  : "bg-surface-800 text-surface-400 hover:text-surface-200"
              )}
            >
              <Icon className="w-3.5 h-3.5" />
              {label}
            </button>
          ))}
        </div>
      </SettingRow>

      <SettingRow
        label="Chat font size"
        description="Font size for messages in the chat window."
        stack
      >
        <Slider
          value={settings.fontSize.chat}
          min={12}
          max={20}
          onChange={(v) =>
            updateSettings({ fontSize: { ...settings.fontSize, chat: v } })
          }
          unit="px"
        />
      </SettingRow>

      <SettingRow
        label="Code font size"
        description="Font size for code blocks and inline code."
        stack
      >
        <Slider
          value={settings.fontSize.code}
          min={10}
          max={18}
          onChange={(v) =>
            updateSettings({ fontSize: { ...settings.fontSize, code: v } })
          }
          unit="px"
        />
      </SettingRow>

      <SettingRow
        label="Send on Enter"
        description="Press Enter to send messages. When off, use Cmd+Enter or Ctrl+Enter."
      >
        <Toggle
          checked={settings.sendOnEnter}
          onChange={(v) => updateSettings({ sendOnEnter: v })}
        />
      </SettingRow>

      <SettingRow
        label="Show timestamps"
        description="Display the time each message was sent."
      >
        <Toggle
          checked={settings.showTimestamps}
          onChange={(v) => updateSettings({ showTimestamps: v })}
        />
      </SettingRow>

      <SettingRow
        label="Compact mode"
        description="Reduce spacing between messages for higher information density."
      >
        <Toggle
          checked={settings.compactMode}
          onChange={(v) => updateSettings({ compactMode: v })}
        />
      </SettingRow>
    </div>
  );
}
