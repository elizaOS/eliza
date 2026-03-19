/**
 * useMiladyBar — Syncs provider, cloud, wallet, and agent state to the macOS menu bar tray.
 *
 * Watches AppContext state and pushes dynamic tray menu updates via the
 * Electrobun RPC bridge. The tray menu shows:
 *   - Agent runtime status (Running/Starting/Stopped/Error + uptime)
 *   - AI provider status (enabled providers with Active/Configured labels)
 *   - Detected credentials from CLI tools, env vars, keychain
 *   - Eliza Cloud credits balance
 *   - Wallet balance summary
 *   - Last refresh timestamp
 *   - Actions: Refresh Now, Show, Settings, Check for Updates, Restart, Quit
 *
 * Auto-refreshes credential scans on a configurable interval (default 5 min).
 * Updates tray tooltip with agent name + state for at-a-glance status.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type DetectedProvider,
  invokeDesktopBridgeRequest,
  scanAndValidateProviderCredentials,
  scanProviderCredentials,
  subscribeDesktopBridgeEvent,
} from "../bridge/electrobun-rpc";
import { isDesktopPlatform } from "../platform";
import { useApp } from "../state";

// ── Constants ─────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

const SOURCE_LABELS: Record<string, string> = {
  "codex-auth": "Codex CLI",
  "claude-credentials": "Claude Code",
  keychain: "Keychain",
  env: "Environment",
};

const STATUS_LABELS: Record<string, string> = {
  valid: "✓ Verified",
  invalid: "✗ Invalid",
  error: "⚠ Error",
  unchecked: "",
};

const AGENT_STATE_LABELS: Record<string, string> = {
  running: "Running",
  starting: "Starting...",
  stopped: "Stopped",
  error: "Error",
  not_started: "Not Started",
  restarting: "Restarting...",
};

const AGENT_STATE_ICONS: Record<string, string> = {
  running: "🟢",
  starting: "🟡",
  restarting: "🟡",
  stopped: "⚪",
  error: "🔴",
  not_started: "⚪",
};

// ── Helpers ───────────────────────────────────────────────────────────

/** Maps detected credential IDs to plugin IDs where they differ. */
const DETECTED_TO_PLUGIN_ID: Record<string, string> = {
  "anthropic-subscription": "anthropic",
};

function normalizeDetectedProviderId(detectedId: string): string {
  return DETECTED_TO_PLUGIN_ID[detectedId] ?? detectedId;
}

function normalizeAiProviderPluginId(value: string): string {
  return value
    .toLowerCase()
    .replace(/^@[^/]+\//, "")
    .replace(/^plugin-/, "");
}

function formatSourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}

function formatTimeAgo(timestamp: number, now: number): string {
  const seconds = Math.floor((now - timestamp) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${seconds}s`;
}

// ── Types ─────────────────────────────────────────────────────────────

interface TrayMenuItem {
  id: string;
  label?: string;
  type?: "normal" | "separator" | "checkbox" | "radio";
  enabled?: boolean;
  checked?: boolean;
  submenu?: TrayMenuItem[];
}

interface AgentStatusInfo {
  state: string;
  agentName?: string;
  startedAt?: number;
}

// ── Menu builder ──────────────────────────────────────────────────────

function buildTrayMenu(state: {
  plugins: Array<{
    id: string;
    name: string;
    category: string;
    enabled: boolean;
    configured: boolean;
  }>;
  detectedProviders: DetectedProvider[];
  agentStatus: AgentStatusInfo | null;
  lastRefreshAt: number | null;
  now: number;
  elizaCloudEnabled: boolean;
  elizaCloudConnected: boolean;
  elizaCloudCredits: number | null;
  walletBalances: unknown;
}): TrayMenuItem[] {
  const menu: TrayMenuItem[] = [];

  // ── Agent Status section ──
  const agentState = state.agentStatus?.state ?? "not_started";
  const agentName = state.agentStatus?.agentName ?? "Milady";
  const stateLabel = AGENT_STATE_LABELS[agentState] ?? agentState;
  const stateIcon = AGENT_STATE_ICONS[agentState] ?? "⚪";

  menu.push({
    id: "agent-status",
    label: `${stateIcon}  ${agentName}  ·  ${stateLabel}`,
    type: "normal",
    enabled: false,
  });

  if (agentState === "running" && state.agentStatus?.startedAt) {
    const uptimeMs = state.now - state.agentStatus.startedAt;
    if (uptimeMs > 0) {
      menu.push({
        id: "agent-uptime",
        label: `     Uptime: ${formatDuration(uptimeMs)}`,
        type: "normal",
        enabled: false,
      });
    }
  }

  if (agentState === "error") {
    menu.push({
      id: "agent-error-hint",
      label: "     Check logs for details",
      type: "normal",
      enabled: false,
    });
  }

  menu.push({ id: "sep-agent", type: "separator" });

  // ── AI Providers section ──
  const aiProviders = state.plugins.filter(
    (p) => p.category === "ai-provider" && p.enabled,
  );

  const detectedById = new Map<string, DetectedProvider>();
  for (const dp of state.detectedProviders) {
    // Map detected IDs to plugin IDs (e.g. "anthropic-subscription" → "anthropic")
    detectedById.set(normalizeDetectedProviderId(dp.id), dp);
  }

  const enabledProviderIds = new Set(
    aiProviders.map((p) => normalizeAiProviderPluginId(p.id)),
  );

  if (aiProviders.length > 0) {
    menu.push({
      id: "providers-header",
      label: "AI Providers",
      type: "normal",
      enabled: false,
    });
    for (const provider of aiProviders) {
      const name = provider.name || normalizeAiProviderPluginId(provider.id);
      const status = provider.enabled
        ? provider.configured
          ? "Active"
          : "Enabled"
        : "Configured";
      const normalizedId = normalizeAiProviderPluginId(provider.id);
      const detected = detectedById.get(normalizedId);
      const sourceStr = detected
        ? `  ·  via ${formatSourceLabel(detected.source)}`
        : "";
      const validationBadge =
        detected?.status && STATUS_LABELS[detected.status]
          ? `  ·  ${STATUS_LABELS[detected.status]}`
          : "";

      const submenuItems: TrayMenuItem[] = [
        {
          id: `provider-action:${normalizedId}:set-active`,
          label: "Set as Active Provider",
          type: "radio",
          checked: provider.configured,
        },
        {
          id: `provider-action:${normalizedId}:test`,
          label: "Test Connection",
          type: "normal",
        },
      ];

      menu.push({
        id: `provider-${provider.id}`,
        label: `  ${name}  ·  ${status}${sourceStr}${validationBadge}`,
        type: "normal",
        submenu: submenuItems,
      });
    }
    menu.push({ id: "sep-providers", type: "separator" });
  }

  // ── Detected Credentials section (providers not already enabled) ──
  const detectedOnly = state.detectedProviders.filter(
    (dp) => !enabledProviderIds.has(normalizeDetectedProviderId(dp.id)),
  );

  if (detectedOnly.length > 0) {
    menu.push({
      id: "detected-header",
      label: "Detected Credentials",
      type: "normal",
      enabled: false,
    });
    for (const dp of detectedOnly) {
      const name = dp.id.charAt(0).toUpperCase() + dp.id.slice(1);
      const validationBadge =
        dp.status && STATUS_LABELS[dp.status]
          ? `  ·  ${STATUS_LABELS[dp.status]}`
          : "";
      const detectedSubmenu: TrayMenuItem[] = [
        {
          id: `provider-action:${dp.id}:enable`,
          label: "Enable & Set Active",
          type: "normal",
        },
        {
          id: `provider-action:${dp.id}:test`,
          label: "Test Connection",
          type: "normal",
        },
      ];

      if (dp.status === "invalid") {
        detectedSubmenu.push({
          id: `provider-action:${dp.id}:invalid-hint`,
          label: `Key Invalid — check source`,
          type: "normal",
          enabled: false,
        });
      }

      menu.push({
        id: `detected-${dp.id}`,
        label: `  ${name}  ·  via ${formatSourceLabel(dp.source)}${validationBadge}`,
        type: "normal",
        submenu: detectedSubmenu,
      });
    }
    menu.push({ id: "sep-detected", type: "separator" });
  }

  // ── Cloud Credits section ──
  if (state.elizaCloudEnabled || state.elizaCloudConnected) {
    if (state.elizaCloudConnected) {
      const credits =
        state.elizaCloudCredits !== null
          ? `$${state.elizaCloudCredits.toFixed(2)}`
          : "Connected";
      menu.push({
        id: "cloud-credits",
        label: `☁️  eliza☁️: ${credits}`,
        type: "normal",
        enabled: false,
      });
    } else {
      menu.push({
        id: "cloud-credits",
        label: "☁️  eliza☁️: Disconnected",
        type: "normal",
        enabled: false,
      });
    }
    menu.push({ id: "sep-cloud", type: "separator" });
  }

  // ── Wallet section ──
  const wb = state.walletBalances as {
    evm?: {
      chains: Array<{
        nativeValueUsd: string;
        tokens: Array<{ valueUsd: string }>;
      }>;
    } | null;
    solana?: {
      solValueUsd: string;
      tokens: Array<{ valueUsd: string }>;
    } | null;
  } | null;

  if (wb) {
    let total = 0;
    if (wb.evm) {
      for (const chain of wb.evm.chains) {
        total += parseFloat(chain.nativeValueUsd) || 0;
        for (const token of chain.tokens) {
          total += parseFloat(token.valueUsd) || 0;
        }
      }
    }
    if (wb.solana) {
      total += parseFloat(wb.solana.solValueUsd) || 0;
      for (const token of wb.solana.tokens) {
        total += parseFloat(token.valueUsd) || 0;
      }
    }
    const formatted = total.toLocaleString("en-US", {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    menu.push({
      id: "wallet-balance",
      label: `💰  Wallet: ${formatted}`,
      type: "normal",
      enabled: false,
    });
    menu.push({ id: "sep-wallet", type: "separator" });
  }

  // ── Last updated ──
  if (state.lastRefreshAt) {
    menu.push({
      id: "last-updated",
      label: `Last updated: ${formatTimeAgo(state.lastRefreshAt, state.now)}`,
      type: "normal",
      enabled: false,
    });
    menu.push({ id: "sep-updated", type: "separator" });
  }

  // ── Actions ──
  menu.push({ id: "refresh-now", label: "Refresh Now", type: "normal" });
  menu.push({ id: "sep-refresh", type: "separator" });
  menu.push({ id: "show", label: "Show Milady", type: "normal" });
  menu.push({ id: "open-settings", label: "Settings...", type: "normal" });
  menu.push({ id: "sep-actions1", type: "separator" });
  menu.push({
    id: "check-for-updates",
    label: "Check for Updates",
    type: "normal",
  });
  menu.push({ id: "sep-actions2", type: "separator" });
  menu.push({ id: "restart-agent", label: "Restart Agent", type: "normal" });
  menu.push({ id: "sep-actions3", type: "separator" });
  menu.push({ id: "quit", label: "Quit", type: "normal" });

  return menu;
}

// ── Hook ──────────────────────────────────────────────────────────────

export function useMiladyBar() {
  const {
    plugins,
    agentStatus,
    elizaCloudEnabled,
    elizaCloudConnected,
    elizaCloudCredits,
    walletBalances,
    onboardingDetectedProviders,
    setTab,
  } = useApp();

  const [scannedProviders, setScannedProviders] = useState<DetectedProvider[]>(
    [],
  );
  const [lastRefreshAt, setLastRefreshAt] = useState<number | null>(null);
  const [now, setNow] = useState(Date.now);
  const refreshTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Fast scan (no validation) — for initial mount
  const runCredentialScan = useCallback(() => {
    if (!isDesktopPlatform()) return;
    scanProviderCredentials()
      .then((results) => {
        setScannedProviders(results);
        setLastRefreshAt(Date.now());
        setNow(Date.now());
      })
      .catch(() => {});
  }, []);

  // Validated scan — for background refresh and manual refresh
  const runValidatedScan = useCallback(() => {
    if (!isDesktopPlatform()) return;
    scanAndValidateProviderCredentials()
      .then((results) => {
        setScannedProviders(results);
        setLastRefreshAt(Date.now());
        setNow(Date.now());
      })
      .catch(() => {});
  }, []);

  // Scan on mount — two-phase: fast initial, then validated in background
  useEffect(() => {
    runCredentialScan(); // fast initial
    // Background validated scan after short delay
    const timeout = setTimeout(() => runValidatedScan(), 1000);
    return () => clearTimeout(timeout);
  }, [runCredentialScan, runValidatedScan]);

  // Auto-refresh interval uses validated scan
  useEffect(() => {
    if (!isDesktopPlatform()) return;
    refreshTimerRef.current = setInterval(() => {
      runValidatedScan();
    }, REFRESH_INTERVAL_MS);
    return () => {
      if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    };
  }, [runValidatedScan]);

  // Merge scanned results with onboarding-detected providers (scan wins on conflict)
  const detectedProviders = useMemo(() => {
    const byId = new Map<string, DetectedProvider>();
    const onboarding = (onboardingDetectedProviders ??
      []) as DetectedProvider[];
    for (const dp of onboarding) {
      byId.set(dp.id, dp);
    }
    for (const dp of scannedProviders) {
      byId.set(dp.id, dp);
    }
    return Array.from(byId.values());
  }, [onboardingDetectedProviders, scannedProviders]);

  // Provider action handler
  const handleProviderAction = useCallback(
    (providerId: string, action: string) => {
      if (action === "test") {
        // Test connection by fetching models
        void fetch(
          `/api/models?provider=${encodeURIComponent(providerId)}&refresh=true`,
        )
          .then(() => runValidatedScan())
          .catch(() => {});
      } else if (action === "enable" || action === "set-active") {
        const detected = detectedProviders.find((dp) => dp.id === providerId);
        const body: Record<string, string> = { provider: providerId };
        if (detected?.apiKey) body.apiKey = detected.apiKey;
        void fetch("/api/provider/switch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
          .then(() => runValidatedScan())
          .catch(() => {});
      }
      // Unknown actions are no-ops
    },
    [detectedProviders, runValidatedScan],
  );

  // Handle tray menu click events (Refresh Now, Open Settings, Provider Actions)
  useEffect(() => {
    if (!isDesktopPlatform()) return;
    return subscribeDesktopBridgeEvent({
      rpcMessage: "desktopTrayMenuClick",
      ipcChannel: "desktop:trayMenuClick",
      listener: (payload) => {
        const { itemId } = payload as { itemId: string };
        if (itemId === "refresh-now") {
          runValidatedScan();
          return;
        }
        if (itemId === "open-settings") {
          void invokeDesktopBridgeRequest({
            rpcMethod: "desktopOpenSettingsWindow",
            ipcChannel: "desktop:openSettingsWindow",
            params: {},
          });
          return;
        }
        if (itemId.startsWith("navigate-")) {
          const target = itemId.replace("navigate-", "");
          setTab?.(target);
          void invokeDesktopBridgeRequest({
            rpcMethod: "desktopShowWindow",
            ipcChannel: "desktop:showWindow",
            params: {},
          });
          return;
        }
        // Provider action submenus: "provider-action:{providerId}:{action}"
        if (itemId.startsWith("provider-action:")) {
          const parts = itemId.split(":");
          const providerId = parts[1];
          const action = parts[2];
          if (providerId && action) {
            handleProviderAction(providerId, action);
          }
        }
      },
    });
  }, [handleProviderAction, runValidatedScan, setTab]);

  const menu = useMemo(
    () =>
      buildTrayMenu({
        plugins: (plugins ?? []) as Array<{
          id: string;
          name: string;
          category: string;
          enabled: boolean;
          configured: boolean;
        }>,
        detectedProviders,
        agentStatus: (agentStatus as AgentStatusInfo | null) ?? null,
        lastRefreshAt,
        now,
        elizaCloudEnabled: Boolean(elizaCloudEnabled),
        elizaCloudConnected: Boolean(elizaCloudConnected),
        elizaCloudCredits: elizaCloudCredits ?? null,
        walletBalances,
      }),
    [
      plugins,
      detectedProviders,
      agentStatus,
      lastRefreshAt,
      now,
      elizaCloudEnabled,
      elizaCloudConnected,
      elizaCloudCredits,
      walletBalances,
    ],
  );

  // Push tray menu updates
  useEffect(() => {
    if (!isDesktopPlatform()) return;

    void invokeDesktopBridgeRequest({
      rpcMethod: "desktopSetTrayMenu",
      ipcChannel: "desktop:setTrayMenu",
      params: { menu },
    });
  }, [menu]);

  // Update tray tooltip with agent status
  useEffect(() => {
    if (!isDesktopPlatform()) return;
    const state =
      (agentStatus as AgentStatusInfo | null)?.state ?? "not_started";
    const name = (agentStatus as AgentStatusInfo | null)?.agentName ?? "Milady";
    const tooltip = `${name} — ${AGENT_STATE_LABELS[state] ?? state}`;
    void invokeDesktopBridgeRequest({
      rpcMethod: "desktopUpdateTray",
      ipcChannel: "desktop:updateTray",
      params: { tooltip },
    });
  }, [agentStatus]);
}
