/**
 * MiladyBarSettings — Standalone macOS-style settings window.
 *
 * Mounted when the app is opened with `?shell=settings`. Renders a
 * CodexBar-style tabbed UI with General, Providers, Advanced, and About tabs.
 * Communicates directly with the agent REST API using fetch — does NOT depend
 * on WebSocket, AppProvider state, or the SettingsView component.
 */
import { useCallback, useEffect, useState } from "react";
import { invokeDesktopBridgeRequest } from "../bridge/electrobun-rpc";

// ── Types ──

interface ProviderPlugin {
  id: string;
  name: string;
  category: string;
  enabled: boolean;
  configured: boolean;
}

interface AgentStatus {
  state: string;
  agentName?: string;
  startedAt?: number;
}

// ── API helpers (direct fetch, no MiladyClient dependency) ──

function getApiBase(): string {
  if (typeof window !== "undefined" && window.__MILADY_API_BASE__) {
    return window.__MILADY_API_BASE__;
  }
  return "http://127.0.0.1:2138";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${getApiBase()}${path}`, init);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

// ── Tab definitions ──

const SETTINGS_TABS = [
  { id: "general", label: "General", icon: "⚙️" },
  { id: "providers", label: "Providers", icon: "🔌" },
  { id: "advanced", label: "Advanced", icon: "🔧" },
  { id: "about", label: "About", icon: "ℹ️" },
] as const;

type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];

function getInitialTab(): SettingsTabId {
  if (typeof window === "undefined") return "general";
  const params = new URLSearchParams(window.location.search);
  const tab = params.get("tab");
  if (tab && SETTINGS_TABS.some((t) => t.id === tab))
    return tab as SettingsTabId;
  if (tab === "plugins" || tab === "connectors") return "providers";
  return "general";
}

// ── Root Component ──

export function MiladyBarSettings() {
  const [activeTab, setActiveTab] = useState<SettingsTabId>(getInitialTab);
  const s = useStyles();

  return (
    <div style={s.root}>
      <div style={s.title}>
        {SETTINGS_TABS.find((t) => t.id === activeTab)?.label ?? "Settings"}
      </div>
      <div style={s.tabBar}>
        {SETTINGS_TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              type="button"
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              style={{ ...s.tab, ...(isActive ? s.tabActive : s.tabInactive) }}
            >
              <span style={{ fontSize: 20 }}>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>
      <div style={s.content}>
        {activeTab === "general" && <GeneralTab />}
        {activeTab === "providers" && <ProvidersTab />}
        {activeTab === "advanced" && <AdvancedTab />}
        {activeTab === "about" && <AboutTab />}
      </div>
    </div>
  );
}

// ── General Tab ──

function GeneralTab() {
  const [agentStatus, setAgentStatus] = useState<AgentStatus | null>(null);
  const [autoLaunch, setAutoLaunch] = useState(false);
  const [credits, setCredits] = useState<number | null>(null);

  useEffect(() => {
    apiFetch<{ state: string; agentName?: string; startedAt?: number }>(
      "/api/status",
    )
      .then(setAgentStatus)
      .catch(() => {});

    invokeDesktopBridgeRequest<{ enabled: boolean }>({
      rpcMethod: "desktopGetAutoLaunchStatus",
      ipcChannel: "desktop:getAutoLaunchStatus",
    })
      .then((r) => {
        if (r) setAutoLaunch(r.enabled);
      })
      .catch(() => {});

    apiFetch<{ credits?: number; balance?: number; connected?: boolean }>(
      "/api/subscription/status",
    )
      .then((r) => {
        const c = r?.credits ?? r?.balance;
        if (c != null) setCredits(c);
      })
      .catch(() => {});
  }, []);

  const toggleAutoLaunch = useCallback(() => {
    const next = !autoLaunch;
    setAutoLaunch(next);
    void invokeDesktopBridgeRequest({
      rpcMethod: "desktopSetAutoLaunch",
      ipcChannel: "desktop:setAutoLaunch",
      params: { enabled: next },
    });
  }, [autoLaunch]);

  const stateLabel =
    agentStatus?.state === "running"
      ? "🟢 Running"
      : agentStatus?.state === "stopped"
        ? "⚪ Stopped"
        : agentStatus?.state === "error"
          ? "🔴 Error"
          : (agentStatus?.state ?? "Loading...");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="AGENT">
        <Row
          label={agentStatus?.agentName ?? "Milady"}
          description={stateLabel}
        />
      </Card>

      <Card title="SYSTEM">
        <ToggleRow
          label="Start at Login"
          description="Automatically opens Milady when you start your Mac."
          checked={autoLaunch}
          onChange={toggleAutoLaunch}
        />
      </Card>

      <Card title="eliza☁️">
        <Row
          label="Credits"
          description={
            credits != null ? `$${credits.toFixed(2)}` : "Not connected"
          }
        />
      </Card>
    </div>
  );
}

// ── Providers Tab ──

function ProvidersTab() {
  const s = useStyles();
  const [plugins, setPlugins] = useState<ProviderPlugin[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<string | null>(null);

  useEffect(() => {
    apiFetch<{ plugins: ProviderPlugin[] }>("/api/plugins")
      .then((r) => {
        const providers = (r.plugins ?? []).filter(
          (p) => p.category === "ai-provider",
        );
        setPlugins(providers);
        if (providers.length > 0) {
          setSelected((current) => current ?? providers[0]?.id ?? null);
        }
      })
      .catch(() => {});
  }, []);

  const selectedPlugin = plugins.find((p) => p.id === selected);

  const handleSave = useCallback(async () => {
    if (!selected || !apiKeyInput.trim()) return;
    setSaving(true);
    setSaveResult(null);
    try {
      await apiFetch("/api/provider/switch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: selected,
          apiKey: apiKeyInput.trim(),
        }),
      });
      setSaveResult("✓ Saved");
      setApiKeyInput("");
      // Refresh plugins
      const r = await apiFetch<{ plugins: ProviderPlugin[] }>("/api/plugins");
      setPlugins((r.plugins ?? []).filter((p) => p.category === "ai-provider"));
    } catch (err) {
      setSaveResult(`✗ ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setSaving(false);
    }
  }, [selected, apiKeyInput]);

  const handleTest = useCallback(async () => {
    if (!selected) return;
    setSaveResult(null);
    try {
      await apiFetch(
        `/api/models?provider=${encodeURIComponent(selected)}&refresh=true`,
      );
      setSaveResult("✓ Connection OK");
    } catch (err) {
      setSaveResult(`✗ ${err instanceof Error ? err.message : "Failed"}`);
    }
  }, [selected]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="AI PROVIDERS">
        {/* Provider list */}
        <div style={{ borderBottom: s.card.border as string }}>
          {plugins.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => {
                setSelected(p.id);
                setSaveResult(null);
                setApiKeyInput("");
              }}
              style={{
                ...s.providerItem,
                ...(selected === p.id ? s.providerItemActive : {}),
              }}
            >
              <div style={{ fontSize: 13, fontWeight: 500 }}>
                {p.name || p.id}
              </div>
              <div style={s.textSecondary}>
                {p.enabled
                  ? p.configured
                    ? "● Active"
                    : "○ Enabled"
                  : "○ Disabled"}
              </div>
            </button>
          ))}
          {plugins.length === 0 && (
            <div
              style={{
                padding: "16px",
                ...s.textSecondary,
                fontSize: 12,
                textAlign: "center",
              }}
            >
              No AI providers found
            </div>
          )}
        </div>

        {/* Selected provider detail */}
        {selectedPlugin && (
          <div style={{ padding: "12px 16px" }}>
            <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 8 }}>
              {selectedPlugin.name || selectedPlugin.id}
            </div>
            <div style={{ fontSize: 11, ...s.textSecondary, marginBottom: 12 }}>
              Status:{" "}
              {selectedPlugin.configured ? "Configured" : "Not configured"}
            </div>

            <div style={{ marginBottom: 8 }}>
              <label
                htmlFor="provider-api-key"
                style={{
                  fontSize: 11,
                  ...s.textSecondary,
                  display: "block",
                  marginBottom: 4,
                }}
              >
                API Key
              </label>
              <input
                id="provider-api-key"
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder={
                  selectedPlugin.configured ? "••••••••" : "Enter API key..."
                }
                style={s.input}
              />
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                onClick={handleSave}
                disabled={saving || !apiKeyInput.trim()}
                style={{
                  ...s.button,
                  opacity: saving || !apiKeyInput.trim() ? 0.5 : 1,
                }}
              >
                {saving ? "Saving..." : "Save & Activate"}
              </button>
              <button
                type="button"
                onClick={handleTest}
                style={s.buttonSecondary}
              >
                Test Connection
              </button>
            </div>

            {saveResult && (
              <div
                style={{
                  marginTop: 8,
                  fontSize: 11,
                  color: saveResult.startsWith("✓") ? "#34c759" : "#ff3b30",
                }}
              >
                {saveResult}
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Advanced Tab ──

function AdvancedTab() {
  const [exporting, setExporting] = useState(false);
  const [exportResult, setExportResult] = useState<string | null>(null);

  const handleExport = useCallback(async () => {
    setExporting(true);
    try {
      const data = await apiFetch("/api/config");
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "milady-config.json";
      a.click();
      URL.revokeObjectURL(url);
      setExportResult("✓ Exported");
    } catch (err) {
      setExportResult(`✗ ${err instanceof Error ? err.message : "Failed"}`);
    } finally {
      setExporting(false);
    }
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="DATA">
        <div
          style={{
            padding: "12px 16px",
            display: "flex",
            gap: 8,
            alignItems: "center",
          }}
        >
          <button
            type="button"
            onClick={handleExport}
            disabled={exporting}
            style={{
              padding: "6px 14px",
              borderRadius: 6,
              border: "none",
              backgroundColor: "#0a84ff",
              color: "#fff",
              fontSize: 12,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            {exporting ? "Exporting..." : "Export Config"}
          </button>
          {exportResult && (
            <span
              style={{
                fontSize: 11,
                color: exportResult.startsWith("✓") ? "#34c759" : "#ff3b30",
              }}
            >
              {exportResult}
            </span>
          )}
        </div>
      </Card>

      <Card title="AGENT">
        <ActionRow
          label="Restart Agent"
          description="Restart the agent process."
          buttonLabel="Restart"
          onClick={() => {
            void apiFetch("/api/agent/restart", { method: "POST" }).catch(
              () => {},
            );
          }}
        />
      </Card>
    </div>
  );
}

// ── About Tab ──

function AboutTab() {
  const [version, setVersion] = useState<{
    version: string;
    name: string;
    runtime: string;
  } | null>(null);

  useEffect(() => {
    invokeDesktopBridgeRequest<{
      version: string;
      name: string;
      runtime: string;
    }>({
      rpcMethod: "desktopGetVersion",
      ipcChannel: "desktop:getVersion",
    })
      .then((r) => {
        if (r) setVersion(r);
      })
      .catch(() => {});
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <Card title="VERSION">
        <Row
          label={version?.name ?? "Milady"}
          description={`Version: ${version?.version ?? "—"}`}
        />
        <Divider />
        <Row label="Runtime" description={version?.runtime ?? "—"} />
        <Divider />
        <Row
          label="Platform"
          description={
            typeof navigator !== "undefined" ? navigator.platform : "—"
          }
        />
      </Card>
    </div>
  );
}

// ── Shared UI Primitives ──

function Card({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  const s = useStyles();
  return (
    <div>
      <div style={s.cardTitle}>{title}</div>
      <div style={s.card}>{children}</div>
    </div>
  );
}

function Row({ label, description }: { label: string; description?: string }) {
  const s = useStyles();
  return (
    <div style={s.row}>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
      {description && (
        <div style={{ fontSize: 11, ...s.textSecondary, marginTop: 2 }}>
          {description}
        </div>
      )}
    </div>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: () => void;
}) {
  const s = useStyles();
  return (
    <div style={s.toggleRow}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {description && (
          <div
            style={{
              fontSize: 11,
              ...s.textSecondary,
              marginTop: 2,
              maxWidth: 400,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <button
        type="button"
        onClick={onChange}
        style={{
          ...s.toggle,
          backgroundColor: checked ? "#34c759" : "#48484a",
        }}
      >
        <div style={{ ...s.toggleThumb, left: checked ? 22 : 2 }} />
      </button>
    </div>
  );
}

function ActionRow({
  label,
  description,
  buttonLabel,
  onClick,
}: {
  label: string;
  description?: string;
  buttonLabel: string;
  onClick: () => void;
}) {
  const s = useStyles();
  return (
    <div style={s.toggleRow}>
      <div>
        <div style={{ fontSize: 13, fontWeight: 500 }}>{label}</div>
        {description && (
          <div
            style={{
              fontSize: 11,
              ...s.textSecondary,
              marginTop: 2,
              maxWidth: 400,
            }}
          >
            {description}
          </div>
        )}
      </div>
      <button type="button" onClick={onClick} style={s.buttonSecondary}>
        {buttonLabel}
      </button>
    </div>
  );
}

function Divider() {
  const t = useTheme();
  return <div style={{ borderTop: `1px solid ${t.border}` }} />;
}

// ── Theme ──

interface ThemeTokens {
  bg: string;
  card: string;
  text: string;
  textSecondary: string;
  border: string;
  borderLight: string;
  accent: string;
  accentText: string;
  tabActive: string;
  tabActiveText: string;
  inputBg: string;
  inputBorder: string;
  buttonSecondaryBg: string;
  providerHover: string;
}

const LIGHT: ThemeTokens = {
  bg: "#f5f5f7",
  card: "#fff",
  text: "#1d1d1f",
  textSecondary: "#86868b",
  border: "#e5e5e7",
  borderLight: "#f0f0f2",
  accent: "#0066cc",
  accentText: "#fff",
  tabActive: "#e8e8ed",
  tabActiveText: "#0066cc",
  inputBg: "#fff",
  inputBorder: "#d1d1d6",
  buttonSecondaryBg: "#fff",
  providerHover: "#f0f0f5",
};

const DARK: ThemeTokens = {
  bg: "#1c1c1e",
  card: "#2c2c2e",
  text: "#f5f5f7",
  textSecondary: "#98989d",
  border: "#38383a",
  borderLight: "#3a3a3c",
  accent: "#0a84ff",
  accentText: "#fff",
  tabActive: "#3a3a3c",
  tabActiveText: "#0a84ff",
  inputBg: "#1c1c1e",
  inputBorder: "#48484a",
  buttonSecondaryBg: "#2c2c2e",
  providerHover: "#3a3a3c",
};

function readStoredTheme(): boolean {
  try {
    const stored = localStorage.getItem("milady:ui-theme");
    if (stored === "light") return false;
    if (stored === "dark") return true;
  } catch {}
  // Fallback: check <html> class, then OS preference
  if (typeof document !== "undefined") {
    if (document.documentElement.classList.contains("dark")) return true;
    if (document.documentElement.getAttribute("data-theme") === "dark")
      return true;
  }
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? true;
}

function applyThemeToDocument(isDark: boolean): void {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle("dark", isDark);
  document.documentElement.setAttribute(
    "data-theme",
    isDark ? "dark" : "light",
  );
}

function useDarkMode(): boolean {
  const [dark, setDark] = useState(readStoredTheme);

  useEffect(() => {
    // Apply theme to this window's <html>
    applyThemeToDocument(dark);
  }, [dark]);

  useEffect(() => {
    // Listen for storage events (cross-window theme sync)
    const onStorage = (e: StorageEvent) => {
      if (e.key === "milady:ui-theme") {
        const isDark = e.newValue !== "light";
        setDark(isDark);
      }
    };
    window.addEventListener("storage", onStorage);

    // Also poll localStorage as a fallback (storage events don't fire
    // within the same browsing context on some WebView implementations)
    const interval = setInterval(() => {
      const current = readStoredTheme();
      setDark((prev) => (prev !== current ? current : prev));
    }, 1000);

    return () => {
      window.removeEventListener("storage", onStorage);
      clearInterval(interval);
    };
  }, []);

  return dark;
}

function useTheme(): ThemeTokens {
  return useDarkMode() ? DARK : LIGHT;
}

// ── Styles (theme-aware factory) ──

function useStyles() {
  const t = useTheme();
  return {
    root: {
      display: "flex" as const,
      flexDirection: "column" as const,
      height: "100vh",
      width: "100vw",
      fontFamily:
        "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
      backgroundColor: t.bg,
      color: t.text,
      overflow: "hidden",
    },
    title: {
      textAlign: "center" as const,
      padding: "16px 0 0",
      fontWeight: 600,
      fontSize: 13,
    },
    tabBar: {
      display: "flex" as const,
      justifyContent: "center" as const,
      gap: 8,
      padding: "12px 24px",
      borderBottom: `1px solid ${t.border}`,
    },
    tab: {
      display: "flex" as const,
      flexDirection: "column" as const,
      alignItems: "center" as const,
      gap: 4,
      padding: "8px 16px",
      border: "none",
      borderRadius: 8,
      cursor: "pointer",
      fontSize: 11,
      transition: "all 0.15s ease",
    },
    tabActive: {
      background: t.tabActive,
      fontWeight: 600,
      color: t.tabActiveText,
    },
    tabInactive: {
      background: "transparent",
      fontWeight: 400,
      color: t.textSecondary,
    },
    content: { flex: 1, overflow: "auto" as const, padding: "16px 24px" },
    tabContent: {
      display: "flex" as const,
      flexDirection: "column" as const,
      gap: 16,
    },
    cardTitle: {
      fontSize: 11,
      fontWeight: 600,
      color: t.textSecondary,
      letterSpacing: 0.5,
      marginBottom: 6,
      paddingLeft: 12,
    },
    card: {
      backgroundColor: t.card,
      borderRadius: 10,
      border: `1px solid ${t.border}`,
      overflow: "hidden",
    },
    row: { padding: "12px 16px" },
    toggleRow: {
      padding: "12px 16px",
      display: "flex" as const,
      alignItems: "center" as const,
      justifyContent: "space-between" as const,
    },
    toggle: {
      width: 44,
      height: 24,
      borderRadius: 12,
      border: "none",
      cursor: "pointer",
      position: "relative" as const,
      transition: "background-color 0.2s",
      flexShrink: 0,
    },
    toggleThumb: {
      width: 20,
      height: 20,
      borderRadius: 10,
      backgroundColor: "#fff",
      position: "absolute" as const,
      top: 2,
      transition: "left 0.2s",
      boxShadow: "0 1px 3px rgba(0,0,0,0.15)",
    },
    providerItem: {
      width: "100%",
      padding: "10px 16px",
      border: "none",
      borderBottom: `1px solid ${t.borderLight}`,
      cursor: "pointer",
      textAlign: "left" as const,
      display: "flex" as const,
      justifyContent: "space-between" as const,
      alignItems: "center" as const,
      background: "transparent",
      color: t.text,
    },
    providerItemActive: { background: t.providerHover },
    input: {
      width: "100%",
      padding: "8px 12px",
      borderRadius: 6,
      border: `1px solid ${t.inputBorder}`,
      fontSize: 13,
      outline: "none",
      fontFamily: "inherit",
      boxSizing: "border-box" as const,
      backgroundColor: t.inputBg,
      color: t.text,
    },
    button: {
      padding: "6px 14px",
      borderRadius: 6,
      border: "none",
      backgroundColor: t.accent,
      color: t.accentText,
      fontSize: 12,
      fontWeight: 500,
      cursor: "pointer",
    },
    buttonSecondary: {
      padding: "6px 14px",
      borderRadius: 6,
      border: `1px solid ${t.border}`,
      backgroundColor: t.buttonSecondaryBg,
      color: t.text,
      fontSize: 12,
      fontWeight: 500,
      cursor: "pointer",
    },
    textSecondary: { color: t.textSecondary },
  };
}
