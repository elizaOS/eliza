"use client";

import { useState } from "react";
import { Download, Trash2, AlertTriangle } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { SettingRow, SectionHeader, Toggle } from "./SettingRow";
import { cn } from "@/lib/utils";

export function DataSettings() {
  const { settings, updateSettings, conversations, deleteConversation } = useChatStore();
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  function exportConversations(format: "json" | "markdown") {
    let content: string;
    let filename: string;
    const ts = new Date().toISOString().split("T")[0];

    if (format === "json") {
      content = JSON.stringify(conversations, null, 2);
      filename = `claude-code-conversations-${ts}.json`;
    } else {
      content = conversations
        .map((conv) => {
          const messages = conv.messages
            .map((m) => {
              const role = m.role === "user" ? "**You**" : "**Claude**";
              const text = typeof m.content === "string"
                ? m.content
                : m.content
                    .filter((b) => b.type === "text")
                    .map((b) => (b as { type: "text"; text: string }).text)
                    .join("\n");
              return `${role}\n\n${text}`;
            })
            .join("\n\n---\n\n");
          return `# ${conv.title}\n\n${messages}`;
        })
        .join("\n\n====\n\n");
      filename = `claude-code-conversations-${ts}.md`;
    }

    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  function clearAllConversations() {
    const ids = conversations.map((c) => c.id);
    ids.forEach((id) => deleteConversation(id));
    setShowClearConfirm(false);
  }

  const totalMessages = conversations.reduce((sum, c) => sum + c.messages.length, 0);

  return (
    <div>
      <SectionHeader title="Data & Privacy" />

      <SettingRow
        label="Export conversations"
        description={`Export all ${conversations.length} conversations (${totalMessages} messages).`}
      >
        <div className="flex gap-2">
          <button
            onClick={() => exportConversations("json")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border",
              "border-surface-700 text-surface-300 hover:text-surface-100 hover:bg-surface-800 transition-colors"
            )}
          >
            <Download className="w-3.5 h-3.5" />
            JSON
          </button>
          <button
            onClick={() => exportConversations("markdown")}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border",
              "border-surface-700 text-surface-300 hover:text-surface-100 hover:bg-surface-800 transition-colors"
            )}
          >
            <Download className="w-3.5 h-3.5" />
            Markdown
          </button>
        </div>
      </SettingRow>

      <SettingRow
        label="Clear conversation history"
        description="Permanently delete all conversations. This cannot be undone."
      >
        {showClearConfirm ? (
          <div className="flex items-center gap-2">
            <span className="text-xs text-red-400 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" />
              Are you sure?
            </span>
            <button
              onClick={clearAllConversations}
              className="px-3 py-1.5 text-xs rounded-md bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              Delete all
            </button>
            <button
              onClick={() => setShowClearConfirm(false)}
              className="px-3 py-1.5 text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              Cancel
            </button>
          </div>
        ) : (
          <button
            onClick={() => setShowClearConfirm(true)}
            disabled={conversations.length === 0}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs border",
              "border-red-500/30 text-red-400 hover:bg-red-500/10 transition-colors",
              "disabled:opacity-40 disabled:cursor-not-allowed"
            )}
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear all
          </button>
        )}
      </SettingRow>

      <SettingRow
        label="Anonymous telemetry"
        description="Help improve Claude Code by sharing anonymous usage data. No conversation content is ever sent."
      >
        <Toggle
          checked={settings.telemetryEnabled}
          onChange={(v) => updateSettings({ telemetryEnabled: v })}
        />
      </SettingRow>

      <div className="mt-6 pt-4 border-t border-surface-800">
        <p className="text-xs text-surface-500">
          All data is stored locally in your browser. Claude Code does not send conversation data
          to any server unless explicitly configured.
        </p>
      </div>
    </div>
  );
}
