import type { Tab } from "@elizaos/ui";
import type React from "react";

/* ── Overlay tab set ───────────────────────────────────────────────── */

/** Only "companion" uses the companion shell. Settings, character, etc. require native (advanced) mode. */
export const COMPANION_OVERLAY_TABS = new Set<Tab>(["companion"]);

/* ── Per-tab accent / color config ─────────────────────────────────── */

export const ACCENT_COLORS: Record<string, string> = {
  skills: "var(--accent)",
  apps: "var(--ok)",
  plugins: "var(--accent)",
  connectors: "var(--accent)",
  knowledge: "#a78bfa",
  wallets: "var(--accent)",
  stream: "var(--danger)",
};

export const TOP_BAR_COLORS: Record<string, string> = {
  skills: "var(--accent)",
  wallets: "color-mix(in srgb, var(--accent) 70%, transparent)",
  stream: "color-mix(in srgb, var(--danger) 70%, transparent)",
  plugins: "var(--accent)",
  connectors: "var(--accent)",
  apps: "color-mix(in srgb, var(--ok) 70%, transparent)",
  knowledge: "rgba(167, 139, 250, 0.7)",
};

/* ── Tab flags ─────────────────────────────────────────────────────── */

export function tabFlags(tab: Tab) {
  const isSkills = tab === "skills";
  const isSettings = tab === "settings" || tab === "triggers";
  const isPlugins = tab === "plugins";
  const isStream = tab === "stream";
  const isWallets = tab === "inventory";
  const isApps = tab === "apps";
  const isConnectors = tab === "connectors";
  const isKnowledge = tab === "knowledge";
  const isAdvancedOverlay =
    tab === "advanced" ||
    tab === "fine-tuning" ||
    tab === "trajectories" ||
    tab === "relationships" ||
    tab === "runtime" ||
    tab === "database" ||
    tab === "logs";
  const isPluginsLike = isPlugins || isConnectors || isSkills;
  const isCentered =
    isSkills ||
    isSettings ||
    isPlugins ||
    isAdvancedOverlay ||
    isApps ||
    isConnectors ||
    isKnowledge ||
    isStream ||
    isWallets;
  const isCharacter = tab === "character" || tab === "character-select";

  return {
    isSkills,
    isSettings,
    isPlugins,
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
    return "rgba(14, 14, 17, 0.94)";
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
  if (f.isPluginsLike) return "var(--accent)";
  if (f.isApps) return "var(--ok)";
  if (f.isKnowledge) return "#a78bfa";
  if (f.isWallets) return "var(--accent)";
  if (f.isStream) return "var(--danger)";
  return "var(--accent)";
}

export function accentSubtleVar(f: TabFlags) {
  if (f.isPluginsLike) return "var(--accent-subtle)";
  if (f.isApps) return "var(--ok-subtle)";
  if (f.isKnowledge) return "rgba(167, 139, 250, 0.12)";
  if (f.isWallets) return "var(--accent-subtle)";
  if (f.isStream) return "var(--destructive-subtle)";
  return "var(--accent-subtle)";
}

export function accentRgbVar(f: TabFlags) {
  if (f.isPluginsLike) return "var(--accent-rgb)";
  if (f.isApps) return "16, 185, 129";
  if (f.isKnowledge) return "167, 139, 250";
  if (f.isWallets) return "var(--accent-rgb)";
  if (f.isStream) return "239, 68, 68";
  return "var(--accent-rgb)";
}

export function accentForegroundVar(f: TabFlags) {
  if (f.isPluginsLike || f.isWallets) return "var(--accent-foreground)";
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

/**
 * Build CSS custom properties for a view wrapper.
 * Content pack color overrides (--pack-*) take precedence via var() fallbacks.
 */
export function viewWrapperStyle(
  f: TabFlags,
  accentColor: string,
): React.CSSProperties {
  // Helper: wrap a value so --pack-* overrides win when set
  const pack = (packVar: string, fallback: string) =>
    `var(${packVar}, ${fallback})`;

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
      "--bg": pack("--pack-bg", "transparent"),
      "--card": pack("--pack-card", "rgba(255, 255, 255, 0.05)"),
      "--border": pack("--pack-border", "rgba(255, 255, 255, 0.08)"),
      "--accent": pack("--pack-accent", accentVar(f)),
      "--accent-foreground": accentForegroundVar(f),
      "--accent-subtle": accentSubtleVar(f),
      "--accent-rgb": accentRgbVar(f),
      "--muted": pack("--pack-text-muted", "rgba(255, 255, 255, 0.45)"),
      "--txt": pack("--pack-text", "rgba(240, 238, 250, 0.92)"),
      "--text": pack("--pack-text", "rgba(240, 238, 250, 0.92)"),
      "--danger": "hsl(0 84.2% 60.2%)",
      "--ok": "hsl(142 76% 36%)",
      "--warning": "var(--warn)",
      "--surface": "rgba(255, 255, 255, 0.06)",
      "--bg-hover": "rgba(255, 255, 255, 0.04)",
      "--bg-muted": "rgba(255, 255, 255, 0.03)",
      "--border-hover": "rgba(255, 255, 255, 0.15)",
    } as React.CSSProperties;
  }
  return {
    "--bg": pack("--pack-bg", "transparent"),
    "--card": pack("--pack-card", "rgba(255, 255, 255, 0.05)"),
    "--border": pack(
      "--pack-border",
      f.isSkills ? "rgba(0,225,255,0.3)" : "rgba(255,255,255,0.08)",
    ),
    "--accent": pack("--pack-accent", accentColor),
    "--accent-foreground": accentForegroundVar(f),
    "--muted": pack("--pack-text-muted", "rgba(255, 255, 255, 0.55)"),
    "--txt": pack("--pack-text", "#ffffff"),
  } as React.CSSProperties;
}
