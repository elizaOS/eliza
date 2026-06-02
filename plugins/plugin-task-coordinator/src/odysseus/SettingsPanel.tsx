// odysseus settings / admin (static/js/settings.js + admin.js). Shows the
// agent's MCP servers + installed plugins (read-only status for now), reusing
// eliza's config backend (client.getMcpStatus / getPlugins). Model-chain /
// TTS-STT / endpoint editors land later.

import type { McpServerStatus, PluginInfo } from "@elizaos/ui";
import { client } from "@elizaos/ui";
import { type ReactNode, useEffect, useState } from "react";

export function SettingsPanel({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactNode {
  const [plugins, setPlugins] = useState<PluginInfo[]>([]);
  const [servers, setServers] = useState<McpServerStatus[]>([]);

  useEffect(() => {
    if (!open) return;
    void client
      .getPlugins()
      .then((r) => setPlugins(r.plugins))
      .catch(() => setPlugins([]));
    void client
      .getMcpStatus()
      .then((r) => setServers(r.servers))
      .catch(() => setServers([]));
  }, [open]);

  if (!open) return null;

  return (
    <div role="dialog" aria-modal="true" aria-label="Settings">
      <button
        type="button"
        aria-label="Close settings"
        onClick={onClose}
        className="od-search-backdrop"
        style={{ zIndex: 55 }}
      />
      <div className="od-search-panel od-mem-panel">
        <div className="od-mem-head">
          <span className="od-mem-title">Settings</span>
          <span className="od-mem-stats">{plugins.length} plugins</span>
        </div>
        <div className="od-search-list">
          <div className="od-set-section">MCP Servers</div>
          {servers.length === 0 ? (
            <div className="od-search-empty">No MCP servers configured.</div>
          ) : (
            servers.map((s) => (
              <div className="od-skill-item" key={s.name}>
                <div className="od-skill-info">
                  <div className="od-skill-name">{s.name}</div>
                  {s.error ? (
                    <div className="od-skill-desc">{s.error}</div>
                  ) : null}
                </div>
                <span className={`od-skill-toggle${s.connected ? " on" : ""}`}>
                  {s.connected ? "Up" : "Down"}
                </span>
              </div>
            ))
          )}
          <div className="od-set-section">Plugins</div>
          {plugins.map((p) => (
            <div className="od-skill-item" key={p.id}>
              <div className="od-skill-info">
                <div className="od-skill-name">{p.name}</div>
                <div className="od-skill-desc">
                  {p.category}
                  {p.configured ? "" : " · not configured"}
                </div>
              </div>
              <span className={`od-skill-toggle${p.enabled ? " on" : ""}`}>
                {p.enabled ? "On" : "Off"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
