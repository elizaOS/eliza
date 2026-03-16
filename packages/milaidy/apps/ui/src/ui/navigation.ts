/**
 * Navigation — simplified to 5 tabs + onboarding.
 */

export type Tab = "chat" | "plugins" | "skills" | "config" | "logs";

export const TAB_GROUPS = [
  { label: "Chat", tabs: ["chat"] as Tab[] },
  { label: "Manage", tabs: ["plugins", "skills"] as Tab[] },
  { label: "Settings", tabs: ["config", "logs"] as Tab[] },
] as const;

const TAB_PATHS: Record<Tab, string> = {
  chat: "/chat",
  plugins: "/plugins",
  skills: "/skills",
  config: "/config",
  logs: "/logs",
};

const PATH_TO_TAB = new Map(
  Object.entries(TAB_PATHS).map(([tab, p]) => [p, tab as Tab]),
);

export function pathForTab(tab: Tab, basePath = ""): string {
  const base = normalizeBasePath(basePath);
  const p = TAB_PATHS[tab];
  return base ? `${base}${p}` : p;
}

export function tabFromPath(pathname: string, basePath = ""): Tab | null {
  const base = normalizeBasePath(basePath);
  let p = pathname || "/";
  if (base) {
    if (p === base) p = "/";
    else if (p.startsWith(`${base}/`)) p = p.slice(base.length);
  }
  let normalized = normalizePath(p).toLowerCase();
  if (normalized.endsWith("/index.html")) normalized = "/";
  if (normalized === "/") return "chat";
  return PATH_TO_TAB.get(normalized) ?? null;
}

export function normalizeBasePath(basePath: string): string {
  if (!basePath) return "";
  let base = basePath.trim();
  if (!base.startsWith("/")) base = `/${base}`;
  if (base === "/") return "";
  if (base.endsWith("/")) base = base.slice(0, -1);
  return base;
}

export function normalizePath(p: string): string {
  if (!p) return "/";
  let normalized = p.trim();
  if (!normalized.startsWith("/")) normalized = `/${normalized}`;
  if (normalized.length > 1 && normalized.endsWith("/")) normalized = normalized.slice(0, -1);
  return normalized;
}

export function titleForTab(tab: Tab): string {
  switch (tab) {
    case "chat": return "Chat";
    case "plugins": return "Plugins";
    case "skills": return "Skills";
    case "config": return "Config";
    case "logs": return "Logs";
    default: return "Milaidy";
  }
}

export function subtitleForTab(tab: Tab): string {
  switch (tab) {
    case "chat": return "Talk to your agent.";
    case "plugins": return "Manage plugins and integrations.";
    case "skills": return "View available skills.";
    case "config": return "Edit configuration.";
    case "logs": return "View agent logs.";
    default: return "";
  }
}
