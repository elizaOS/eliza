"use client";

import { useState } from "react";
import {
  Plus,
  Trash2,
  CheckCircle,
  XCircle,
  Loader2,
  ChevronDown,
  Circle,
} from "lucide-react";
import { nanoid } from "nanoid";
import { useChatStore } from "@/lib/store";
import type { MCPServerConfig } from "@/lib/types";
import { SectionHeader, Toggle } from "./SettingRow";
import { cn } from "@/lib/utils";

type TestStatus = "idle" | "testing" | "ok" | "error";

function ServerRow({
  server,
  onUpdate,
  onDelete,
}: {
  server: MCPServerConfig;
  onUpdate: (updated: MCPServerConfig) => void;
  onDelete: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [testStatus, setTestStatus] = useState<TestStatus>("idle");

  async function testConnection() {
    setTestStatus("testing");
    // Simulate connection test — in real impl this would call an API
    await new Promise((r) => setTimeout(r, 800));
    setTestStatus(Math.random() > 0.3 ? "ok" : "error");
  }

  const statusDot = {
    idle: <Circle className="w-2 h-2 text-surface-600" />,
    testing: <Loader2 className="w-3 h-3 animate-spin text-surface-400" />,
    ok: <CheckCircle className="w-3 h-3 text-green-400" />,
    error: <XCircle className="w-3 h-3 text-red-400" />,
  }[testStatus];

  return (
    <div className="border border-surface-800 rounded-lg overflow-hidden">
      {/* Header row */}
      <div className="flex items-center gap-3 px-3 py-2.5 bg-surface-800/40">
        <Toggle
          checked={server.enabled}
          onChange={(v) => onUpdate({ ...server, enabled: v })}
        />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-surface-200 truncate">{server.name}</p>
          <p className="text-xs text-surface-500 font-mono truncate">{server.command}</p>
        </div>
        <div className="flex items-center gap-2">
          {statusDot}
          <button
            onClick={testConnection}
            disabled={testStatus === "testing"}
            className="text-xs text-surface-400 hover:text-surface-200 transition-colors disabled:opacity-50"
          >
            Test
          </button>
          <button
            onClick={() => setExpanded((v) => !v)}
            className="text-surface-500 hover:text-surface-300 transition-colors"
          >
            <ChevronDown
              className={cn("w-4 h-4 transition-transform", expanded && "rotate-180")}
            />
          </button>
          <button
            onClick={onDelete}
            className="text-surface-500 hover:text-red-400 transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Expanded edit form */}
      {expanded && (
        <div className="px-3 py-3 space-y-2 border-t border-surface-800">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-surface-400 mb-1">Name</label>
              <input
                value={server.name}
                onChange={(e) => onUpdate({ ...server, name: e.target.value })}
                className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs text-surface-400 mb-1">Command</label>
              <input
                value={server.command}
                onChange={(e) => onUpdate({ ...server, command: e.target.value })}
                placeholder="npx, node, python..."
                className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-surface-200 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-surface-400 mb-1">
              Arguments (space-separated)
            </label>
            <input
              value={server.args.join(" ")}
              onChange={(e) =>
                onUpdate({
                  ...server,
                  args: e.target.value.split(" ").filter(Boolean),
                })
              }
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-surface-200 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
        </div>
      )}
    </div>
  );
}

export function McpSettings() {
  const { settings, updateSettings } = useChatStore();
  const [showAddForm, setShowAddForm] = useState(false);
  const [newServer, setNewServer] = useState<Omit<MCPServerConfig, "id">>({
    name: "",
    command: "",
    args: [],
    env: {},
    enabled: true,
  });

  function updateServer(id: string, updated: MCPServerConfig) {
    updateSettings({
      mcpServers: settings.mcpServers.map((s) => (s.id === id ? updated : s)),
    });
  }

  function deleteServer(id: string) {
    updateSettings({
      mcpServers: settings.mcpServers.filter((s) => s.id !== id),
    });
  }

  function addServer() {
    if (!newServer.name.trim() || !newServer.command.trim()) return;
    updateSettings({
      mcpServers: [...settings.mcpServers, { ...newServer, id: nanoid() }],
    });
    setNewServer({ name: "", command: "", args: [], env: {}, enabled: true });
    setShowAddForm(false);
  }

  return (
    <div>
      <SectionHeader title="MCP Servers" />

      <p className="text-xs text-surface-400 mb-4">
        Model Context Protocol servers extend Claude with external tools and data sources.
      </p>

      <div className="space-y-2 mb-4">
        {settings.mcpServers.length === 0 ? (
          <div className="text-center py-8 text-surface-500 text-sm">
            No MCP servers configured
          </div>
        ) : (
          settings.mcpServers.map((server) => (
            <ServerRow
              key={server.id}
              server={server}
              onUpdate={(updated) => updateServer(server.id, updated)}
              onDelete={() => deleteServer(server.id)}
            />
          ))
        )}
      </div>

      {showAddForm ? (
        <div className="border border-surface-700 rounded-lg p-3 space-y-2">
          <p className="text-xs font-medium text-surface-300 mb-2">Add MCP server</p>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="block text-xs text-surface-400 mb-1">Name *</label>
              <input
                value={newServer.name}
                onChange={(e) => setNewServer((s) => ({ ...s, name: e.target.value }))}
                placeholder="filesystem"
                className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-surface-200 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div>
              <label className="block text-xs text-surface-400 mb-1">Command *</label>
              <input
                value={newServer.command}
                onChange={(e) => setNewServer((s) => ({ ...s, command: e.target.value }))}
                placeholder="npx"
                className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-surface-200 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-surface-400 mb-1">
              Arguments (space-separated)
            </label>
            <input
              value={newServer.args.join(" ")}
              onChange={(e) =>
                setNewServer((s) => ({
                  ...s,
                  args: e.target.value.split(" ").filter(Boolean),
                }))
              }
              placeholder="-y @modelcontextprotocol/server-filesystem /path"
              className="w-full bg-surface-800 border border-surface-700 rounded px-2 py-1 text-xs text-surface-200 font-mono focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          </div>
          <div className="flex justify-end gap-2 pt-1">
            <button
              onClick={() => setShowAddForm(false)}
              className="px-3 py-1.5 text-xs text-surface-400 hover:text-surface-200 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={addServer}
              disabled={!newServer.name.trim() || !newServer.command.trim()}
              className={cn(
                "px-3 py-1.5 text-xs rounded-md bg-brand-600 text-white",
                "hover:bg-brand-700 transition-colors",
                "disabled:opacity-50 disabled:cursor-not-allowed"
              )}
            >
              Add server
            </button>
          </div>
        </div>
      ) : (
        <button
          onClick={() => setShowAddForm(true)}
          className="flex items-center gap-2 text-sm text-surface-400 hover:text-surface-200 transition-colors"
        >
          <Plus className="w-4 h-4" />
          Add server
        </button>
      )}
    </div>
  );
}
