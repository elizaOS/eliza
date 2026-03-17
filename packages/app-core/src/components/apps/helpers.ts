import type { RegistryAppInfo } from "../../api";

export const DEFAULT_VIEWER_SANDBOX =
  "allow-scripts allow-same-origin allow-popups";

const PROD_ALLOWED_APPS = new Set(["@iqlabs-official/plugin-clawbal"]);

export const CATEGORY_LABELS: Record<string, string> = {
  game: "Game",
  social: "Social",
  platform: "Platform",
  world: "World",
};

export function shouldShowAppInAppsView(
  app: Pick<RegistryAppInfo, "name">,
  isProd = import.meta.env.PROD,
): boolean {
  if (!isProd) return true;
  return PROD_ALLOWED_APPS.has(app.name);
}

export function getAppShortName(app: RegistryAppInfo): string {
  const display = app.displayName ?? app.name;
  const clean = display.replace(/^@[^/]+\/app-/, "");
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

export function getAppEmoji(app: RegistryAppInfo): string {
  const name = (app.name ?? "").toLowerCase();
  if (name.includes("2004") || name.includes("runescape")) return "⚔️";
  if (name.includes("town")) return "🏘️";
  if (name.includes("babylon")) return "🏛️";
  if (name.includes("clawbal")) return "🎯";
  if (name.includes("minecraft")) return "⛏️";
  if (name.includes("roblox")) return "🧱";
  if (name.includes("dungeons")) return "🗡️";
  if (name.includes("hyperfy")) return "🌀";
  if (app.category === "game") return "🎮";
  if (app.category === "social") return "💬";
  if (app.category === "world") return "🌍";
  return "📦";
}
