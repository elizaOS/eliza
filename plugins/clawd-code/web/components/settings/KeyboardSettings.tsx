"use client";

import { useState, useEffect, useRef } from "react";
import { RotateCcw } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { SectionHeader } from "./SettingRow";
import { cn } from "@/lib/utils";

const DEFAULT_SHORTCUTS: Record<string, string> = {
  "new-conversation": "Ctrl+Shift+N",
  "send-message": "Enter",
  "focus-input": "Ctrl+L",
  "toggle-sidebar": "Ctrl+B",
  "open-settings": "Ctrl+,",
  "command-palette": "Ctrl+K",
};

const SHORTCUT_LABELS: Record<string, { label: string; description: string }> = {
  "new-conversation": { label: "New conversation", description: "Start a fresh conversation" },
  "send-message": { label: "Send message", description: "Submit the current message" },
  "focus-input": { label: "Focus input", description: "Jump to the message input" },
  "toggle-sidebar": { label: "Toggle sidebar", description: "Show or hide the sidebar" },
  "open-settings": { label: "Open settings", description: "Open this settings panel" },
  "command-palette": { label: "Command palette", description: "Open the command palette" },
};

function captureKeyCombo(e: KeyboardEvent): string {
  e.preventDefault();
  const parts: string[] = [];
  if (e.ctrlKey || e.metaKey) parts.push("Ctrl");
  if (e.altKey) parts.push("Alt");
  if (e.shiftKey) parts.push("Shift");
  if (e.key && !["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
    parts.push(e.key === " " ? "Space" : e.key);
  }
  return parts.join("+");
}

function ShortcutRow({
  id,
  binding,
  isDefault,
  isConflict,
  onRebind,
  onReset,
}: {
  id: string;
  binding: string;
  isDefault: boolean;
  isConflict: boolean;
  onRebind: (combo: string) => void;
  onReset: () => void;
}) {
  const [listening, setListening] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const info = SHORTCUT_LABELS[id];

  useEffect(() => {
    if (!listening) return;
    function handler(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setListening(false);
        return;
      }
      const combo = captureKeyCombo(e);
      if (combo) {
        onRebind(combo);
        setListening(false);
      }
    }
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [listening, onRebind]);

  return (
    <div
      className={cn(
        "flex items-center justify-between py-3 border-b border-surface-800 last:border-0",
        isConflict && "bg-red-500/5"
      )}
    >
      <div className="flex-1">
        <p className="text-sm text-surface-200">{info?.label ?? id}</p>
        <p className="text-xs text-surface-500">{info?.description}</p>
        {isConflict && (
          <p className="text-xs text-red-400 mt-0.5">Conflict with another shortcut</p>
        )}
      </div>
      <div className="flex items-center gap-2">
        <button
          ref={ref}
          onClick={() => setListening(true)}
          className={cn(
            "px-3 py-1 rounded-md text-xs font-mono transition-colors border",
            listening
              ? "bg-brand-600/20 border-brand-500 text-brand-300 animate-pulse"
              : isConflict
              ? "bg-red-500/10 border-red-500/30 text-red-300"
              : "bg-surface-800 border-surface-700 text-surface-300 hover:border-surface-600"
          )}
        >
          {listening ? "Press keys..." : binding}
        </button>
        {!isDefault && (
          <button
            onClick={onReset}
            title="Reset to default"
            className="text-surface-500 hover:text-surface-300 transition-colors"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        )}
      </div>
    </div>
  );
}

export function KeyboardSettings() {
  const { settings, updateSettings, resetSettings } = useChatStore();
  const keybindings = settings.keybindings;

  // Find conflicts
  const bindingValues = Object.values(keybindings);
  const conflicts = new Set(
    bindingValues.filter((v, i) => bindingValues.indexOf(v) !== i)
  );

  function rebind(id: string, combo: string) {
    updateSettings({ keybindings: { ...keybindings, [id]: combo } });
  }

  function resetOne(id: string) {
    updateSettings({
      keybindings: { ...keybindings, [id]: DEFAULT_SHORTCUTS[id] },
    });
  }

  return (
    <div>
      <SectionHeader title="Keyboard Shortcuts" onReset={() => resetSettings("keybindings")} />

      <p className="text-xs text-surface-400 mb-4">
        Click a shortcut to rebind it. Press Escape to cancel.
      </p>

      <div>
        {Object.entries(keybindings).map(([id, binding]) => (
          <ShortcutRow
            key={id}
            id={id}
            binding={binding}
            isDefault={binding === DEFAULT_SHORTCUTS[id]}
            isConflict={conflicts.has(binding)}
            onRebind={(combo) => rebind(id, combo)}
            onReset={() => resetOne(id)}
          />
        ))}
      </div>
    </div>
  );
}
