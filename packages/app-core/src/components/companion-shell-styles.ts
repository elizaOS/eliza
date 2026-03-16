/**
 * Style helpers and constants for the companion shell overlay.
 */

import type { Tab } from "@elizaos/app-core/navigation";
import type React from "react";

/* ── Overlay tab set ───────────────────────────────────────────────── */

/** Only "companion" uses the companion shell. Settings, character, etc. require native (advanced) mode. */
export const COMPANION_OVERLAY_TABS = new Set<Tab>(["companion"]);

/* ── Per-tab accent / color config ─────────────────────────────────── */

export const ACCENT_COLORS: Record<string, string> = {
  skills: "#f0b232",
  apps: "#10b981",
  plugins: "#f0b232",
  connectors: "#f0b232",
  knowledge: "#a78bfa",
  wallets: "#f0b90b",
  stream: "#ef4444",
  lifo: "#8b5cf6",
};

export const TOP_BAR_COLORS: Record<string, string> = {
  skills: "#f0b232",
  wallets: "rgba(240, 185, 11, 0.7)",
  lifo: "rgba(139, 92, 246, 0.7)",
  stream: "rgba(239, 68, 68, 0.7)",
  plugins: "#f0b232",
  connectors: "#f0b232",
  apps: "rgba(16, 185, 129, 0.7)",
  knowledge: "rgba(167, 139, 250, 0.7)",
};

/* ── Tab flags ─────────────────────────────────────────────────────── */

export function tabFlags(tab: Tab) {
  const isSkills = tab === "skills";
  const isSettings = tab === "settings" || tab === "triggers";
  const isPlugins = tab === "plugins";
  const isLifo = tab === "lifo";
  const isStream = tab === "stream";
  const isWallets = tab === "wallets";
  const isApps = tab === "apps";
  const isConnectors = tab === "connectors";
  const isKnowledge = tab === "knowledge";
  const isAdvancedOverlay =
    tab === "advanced" ||
    tab === "actions" ||
    tab === "fine-tuning" ||
    tab === "trajectories" ||
    tab === "runtime" ||
    tab === "database" ||
    tab === "logs" ||
    tab === "security" ||
    isLifo;
  const isPluginsLike = isPlugins || isConnectors || isSkills;
  const isCentered =
    isSkills ||
    isSettings ||
    isPlugins ||
    isAdvancedOverlay ||
    isApps ||
    isConnectors ||
    isKnowledge ||
    isLifo ||
    isStream ||
    isWallets;
  const isCharacter = tab === "character" || tab === "character-select";

  return {
    isSkills,
    isSettings,
    isPlugins,
    isLifo,
    isStream,
    isWallets,
    isApps,
    isConnectors,
    isKnowledge,
    isAdvancedOverlay,
    isPluginsLike,
    isCentered,
    isCharacter,
  };
}

export type TabFlags = ReturnType<typeof tabFlags>;

/* ── Layout helpers ────────────────────────────────────────────────── */

export function overlayBackdropClass(f: TabFlags) {
  if (f.isPluginsLike)
    return "opacity-100 backdrop-blur-xl bg-black/35 pointer-events-auto";
  if (
    f.isSettings ||
    f.isAdvancedOverlay ||
    f.isApps ||
    f.isKnowledge ||
    f.isLifo ||
    f.isStream ||
    f.isWallets
  )
    return "opacity-100 backdrop-blur-2xl bg-black/50 pointer-events-auto";
  if (f.isCharacter) return "opacity-100";
  return "opacity-0";
}

export function cardSizeClass(f: TabFlags) {
  if (f.isPluginsLike)
    return "w-[97vw] h-[92vh] md:w-[88vw] md:h-[80vh] max-w-[1460px] overflow-visible";
  if (f.isAdvancedOverlay)
    return "w-[95vw] h-[95vh] max-w-[1500px] backdrop-blur-3xl border rounded-2xl overflow-hidden";
  if (f.isSettings || f.isApps || f.isKnowledge || f.isWallets)
    return "w-[90vw] h-[90vh] max-w-5xl backdrop-blur-3xl border rounded-2xl overflow-hidden";
  return "w-[65vw] min-w-[700px] h-[100vh] border-l backdrop-blur-2xl";
}

export function cardBackground(f: TabFlags) {
  if (f.isPluginsLike) return "transparent";
  if (
    f.isSettings ||
    f.isAdvancedOverlay ||
    f.isApps ||
    f.isKnowledge ||
    f.isWallets
  )
    return "rgba(18, 22, 32, 0.92)";
  return "linear-gradient(to left, rgba(6, 8, 12, 0.95) 40%, rgba(6, 8, 12, 0.7) 80%, rgba(6, 8, 12, 0.2) 100%)";
}

export function cardBorderColor(f: TabFlags) {
  if (f.isPluginsLike) return "transparent";
  if (
    f.isSettings ||
    f.isAdvancedOverlay ||
    f.isApps ||
    f.isKnowledge ||
    f.isWallets
  )
    return "rgba(255, 255, 255, 0.08)";
  return "rgba(255,255,255,0.05)";
}

export function cardBoxShadow(f: TabFlags, _shadowFx: string) {
  if (f.isPluginsLike) return "none";
  if (
    f.isSettings ||
    f.isAdvancedOverlay ||
    f.isApps ||
    f.isKnowledge ||
    f.isWallets
  )
    return "0 8px 60px rgba(0,0,0,0.6), 0 2px 24px rgba(0,0,0,0.4)";
  return "-60px 0 100px -20px rgba(0,0,0,0.8)";
}

/* ── Accent color helpers ──────────────────────────────────────────── */

export function accentVar(f: TabFlags) {
  if (f.isPluginsLike) return "#f0b232";
  if (f.isApps) return "#10b981";
  if (f.isKnowledge) return "#a78bfa";
  if (f.isWallets) return "#f0b90b";
  if (f.isLifo) return "#8b5cf6";
  if (f.isStream) return "#ef4444";
  return "#7b8fb5";
}

export function accentSubtleVar(f: TabFlags) {
  if (f.isPluginsLike) return "rgba(240, 178, 50, 0.12)";
  if (f.isApps) return "rgba(16, 185, 129, 0.12)";
  if (f.isKnowledge) return "rgba(167, 139, 250, 0.12)";
  if (f.isWallets) return "rgba(240, 185, 11, 0.12)";
  if (f.isLifo) return "rgba(139, 92, 246, 0.12)";
  if (f.isStream) return "rgba(239, 68, 68, 0.12)";
  return "rgba(123, 143, 181, 0.12)";
}

export function accentRgbVar(f: TabFlags) {
  if (f.isPluginsLike) return "240, 178, 50";
  if (f.isApps) return "16, 185, 129";
  if (f.isKnowledge) return "167, 139, 250";
  if (f.isWallets) return "240, 185, 11";
  if (f.isLifo) return "139, 92, 246";
  if (f.isStream) return "239, 68, 68";
  return "123, 143, 181";
}

export function accentForegroundVar(f: TabFlags) {
  if (f.isPluginsLike || f.isWallets) return "#1a1f26";
  return "#ffffff";
}

/* ── View wrapper helpers ──────────────────────────────────────────── */

export function viewWrapperOverflow(f: TabFlags) {
  if (f.isPluginsLike) return "overflow-visible";
  if (
    f.isSettings ||
    f.isAdvancedOverlay ||
    f.isApps ||
    f.isConnectors ||
    f.isWallets
  )
    return "overflow-hidden";
  return "overflow-y-auto";
}

export function viewWrapperPadding(f: TabFlags) {
  // Skills now uses isPluginsLike path (p-0)
  if (
    f.isSettings ||
    f.isAdvancedOverlay ||
    f.isApps ||
    f.isConnectors ||
    f.isPlugins ||
    f.isWallets
  )
    return "p-0";
  if (f.isKnowledge) return "px-8 py-8";
  return "px-16 pt-32 pb-16";
}

export function viewWrapperStyle(
  f: TabFlags,
  accentColor: string,
): React.CSSProperties {
  if (
    f.isSettings ||
    f.isPlugins ||
    f.isSkills ||
    f.isAdvancedOverlay ||
    f.isApps ||
    f.isConnectors ||
    f.isKnowledge ||
    f.isWallets
  ) {
    return {
      "--bg": "transparent",
      "--card": "rgba(255, 255, 255, 0.05)",
      "--border": "rgba(255, 255, 255, 0.08)",
      "--accent": accentVar(f),
      "--accent-foreground": accentForegroundVar(f),
      "--accent-subtle": accentSubtleVar(f),
      "--accent-rgb": accentRgbVar(f),
      "--muted": "rgba(255, 255, 255, 0.45)",
      "--txt": "rgba(240, 238, 250, 0.92)",
      "--text": "rgba(240, 238, 250, 0.92)",
      "--danger": "#ef4444",
      "--ok": "#22c55e",
      "--warning": "#f59e0b",
      "--surface": "rgba(255, 255, 255, 0.06)",
      "--bg-hover": "rgba(255, 255, 255, 0.04)",
      "--bg-muted": "rgba(255, 255, 255, 0.03)",
      "--border-hover": "rgba(255, 255, 255, 0.15)",
    } as React.CSSProperties;
  }
  return {
    "--bg": "transparent",
    "--card": "rgba(255, 255, 255, 0.05)",
    "--border": f.isSkills ? "rgba(0,225,255,0.3)" : "rgba(255,255,255,0.08)",
    "--accent": accentColor,
    "--accent-foreground": accentForegroundVar(f),
    "--muted": "rgba(255, 255, 255, 0.55)",
    "--txt": "#ffffff",
  } as React.CSSProperties;
}
