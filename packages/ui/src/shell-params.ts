export type DetachedShellTab =
  | "browser"
  | "chat"
  | "release"
  | "triggers"
  | "plugins"
  | "cloud";

export type ShellRoute =
  | { mode: "main" }
  | { mode: "settings"; tab?: string }
  | { mode: "surface"; tab: DetachedShellTab };

export function parseShellRoute(search: string): ShellRoute {
  const params = new URLSearchParams(search);
  const shell = params.get("shell");

  if (shell === "settings") {
    const tab = params.get("tab")?.trim() || undefined;
    return tab ? { mode: "settings", tab } : { mode: "settings" };
  }

  if (shell === "surface") {
    const tab = params.get("tab");
    if (
      tab === "browser" ||
      tab === "chat" ||
      tab === "release" ||
      tab === "triggers" ||
      tab === "plugins" ||
      tab === "cloud"
    ) {
      return { mode: "surface", tab };
    }
  }

  return { mode: "main" };
}
