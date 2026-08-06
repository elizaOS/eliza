"use client";

import { useState } from "react";
import { Plus, X } from "lucide-react";
import { useChatStore } from "@/lib/store";
import { SettingRow, SectionHeader, Toggle } from "./SettingRow";
import { cn } from "@/lib/utils";

const TOOL_LABELS: Record<string, { label: string; description: string }> = {
  file_read: {
    label: "File read",
    description: "Read files from the filesystem",
  },
  file_write: {
    label: "File write",
    description: "Create or modify files",
  },
  bash: {
    label: "Bash commands",
    description: "Execute shell commands",
  },
  web_search: {
    label: "Web search",
    description: "Search the internet",
  },
};

export function PermissionSettings() {
  const { settings, updateSettings, resetSettings } = useChatStore();
  const [newDir, setNewDir] = useState("");

  function toggleAutoApprove(tool: string, value: boolean) {
    updateSettings({
      permissions: {
        ...settings.permissions,
        autoApprove: { ...settings.permissions.autoApprove, [tool]: value },
      },
    });
  }

  function addRestrictedDir() {
    const dir = newDir.trim();
    if (!dir || settings.permissions.restrictedDirs.includes(dir)) return;
    updateSettings({
      permissions: {
        ...settings.permissions,
        restrictedDirs: [...settings.permissions.restrictedDirs, dir],
      },
    });
    setNewDir("");
  }

  function removeRestrictedDir(dir: string) {
    updateSettings({
      permissions: {
        ...settings.permissions,
        restrictedDirs: settings.permissions.restrictedDirs.filter((d) => d !== dir),
      },
    });
  }

  return (
    <div>
      <SectionHeader title="Permissions & Safety" onReset={() => resetSettings("permissions")} />

      <div className="mb-4 p-3 rounded-md bg-amber-500/10 border border-amber-500/20 text-xs text-amber-300">
        Auto-approving tools means Claude can perform these actions without asking for confirmation.
        Use with caution.
      </div>

      {Object.entries(TOOL_LABELS).map(([tool, { label, description }]) => (
        <SettingRow key={tool} label={label} description={description}>
          <Toggle
            checked={!!settings.permissions.autoApprove[tool]}
            onChange={(v) => toggleAutoApprove(tool, v)}
          />
        </SettingRow>
      ))}

      <SettingRow
        label="Restricted directories"
        description="Limit file operations to specific directories. Leave empty for no restriction."
        stack
      >
        <div className="space-y-2">
          {settings.permissions.restrictedDirs.map((dir) => (
            <div
              key={dir}
              className="flex items-center justify-between gap-2 px-2 py-1 rounded bg-surface-800 border border-surface-700"
            >
              <span className="text-xs font-mono text-surface-300 truncate">{dir}</span>
              <button
                onClick={() => removeRestrictedDir(dir)}
                className="text-surface-500 hover:text-red-400 transition-colors flex-shrink-0"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex gap-2">
            <input
              type="text"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && addRestrictedDir()}
              placeholder="/path/to/directory"
              className={cn(
                "flex-1 bg-surface-800 border border-surface-700 rounded-md px-3 py-1.5 text-xs",
                "text-surface-200 placeholder-surface-600 focus:outline-none focus:ring-1 focus:ring-brand-500 font-mono"
              )}
            />
            <button
              onClick={addRestrictedDir}
              className={cn(
                "flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs",
                "bg-surface-800 border border-surface-700 text-surface-300",
                "hover:text-surface-100 hover:bg-surface-700 transition-colors"
              )}
            >
              <Plus className="w-3.5 h-3.5" />
              Add
            </button>
          </div>
        </div>
      </SettingRow>
    </div>
  );
}
