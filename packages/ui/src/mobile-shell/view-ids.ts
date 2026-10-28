/**
 * Canonical view ids of the mobile shell. They are the ids the agent's VIEWS
 * action, the builtin route registry and plugin view declarations already
 * use, so a product maps its own older keys once instead of keeping aliases.
 */
export const MOBILE_SHELL_VIEW_IDS = [
  "chat",
  "inbox",
  "calendar",
  "reminders",
  "notes",
  "automations",
  "browser",
  "camera",
  "photos",
  "maps",
  "files",
  "contacts",
  "phone",
  "messages",
  "clock",
  "settings",
  "inventory",
] as const;

export type MobileShellViewId = (typeof MOBILE_SHELL_VIEW_IDS)[number];

/** Home is the chat surface in the shared navigation vocabulary. */
export const MOBILE_SHELL_HOME_VIEW_ID = "chat" satisfies MobileShellViewId;

const VIEW_IDS: ReadonlySet<string> = new Set(MOBILE_SHELL_VIEW_IDS);

export function isMobileShellViewId(
  value: unknown,
): value is MobileShellViewId {
  return typeof value === "string" && VIEW_IDS.has(value);
}

/** Builtin routes whose path is not `/<id>`. */
const VIEW_PATHS: Partial<Record<MobileShellViewId, string>> = {
  files: "/apps/files",
  inventory: "/wallet",
};

/** The canonical route path of a view; Home is `/chat`. */
export function mobileShellViewPath(id: MobileShellViewId): string {
  return VIEW_PATHS[id] ?? `/${id}`;
}

/**
 * Paths a navigation handoff may name for a view: its route path, `/<id>`,
 * `/apps/<id>`, and `/` for Home.
 */
export function mobileShellViewPaths(id: MobileShellViewId): string[] {
  const paths = new Set([mobileShellViewPath(id), `/${id}`, `/apps/${id}`]);
  if (id === MOBILE_SHELL_HOME_VIEW_ID) paths.add("/");
  return [...paths];
}
