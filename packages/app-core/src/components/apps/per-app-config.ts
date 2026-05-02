/**
 * Per-app config — launch mode, always-on-top default, and free-form
 * app-declared settings. NOT widget visibility (lives in widgets/visibility.ts).
 *
 * Persisted to localStorage under `eliza:apps:<slug>`. Subscribers receive
 * change notifications via the `storage` event so multiple windows stay in
 * sync.
 */

export type AppLaunchMode = "window" | "inline";

export interface PerAppConfig {
  launchMode: AppLaunchMode;
  alwaysOnTop: boolean;
  settings: Record<string, unknown>;
}

const DEFAULT_CONFIG: PerAppConfig = {
  launchMode: "window",
  alwaysOnTop: false,
  settings: {},
};

const KEY_PREFIX = "eliza:apps:";

function storageKey(slug: string): string {
  return `${KEY_PREFIX}${slug}`;
}

function isLaunchMode(value: unknown): value is AppLaunchMode {
  return value === "window" || value === "inline";
}

function sanitizeSettings(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const next: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === "string" && key.length > 0) {
      next[key] = raw;
    }
  }
  return next;
}

function parseConfig(raw: string | null): PerAppConfig {
  if (!raw) return { ...DEFAULT_CONFIG, settings: {} };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ...DEFAULT_CONFIG, settings: {} };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ...DEFAULT_CONFIG, settings: {} };
  }
  const candidate = parsed as Record<string, unknown>;
  return {
    launchMode: isLaunchMode(candidate.launchMode)
      ? candidate.launchMode
      : DEFAULT_CONFIG.launchMode,
    alwaysOnTop:
      typeof candidate.alwaysOnTop === "boolean"
        ? candidate.alwaysOnTop
        : DEFAULT_CONFIG.alwaysOnTop,
    settings: sanitizeSettings(candidate.settings),
  };
}

export function loadPerAppConfig(slug: string): PerAppConfig {
  if (typeof window === "undefined") return { ...DEFAULT_CONFIG, settings: {} };
  try {
    return parseConfig(window.localStorage.getItem(storageKey(slug)));
  } catch {
    return { ...DEFAULT_CONFIG, settings: {} };
  }
}

export function savePerAppConfig(slug: string, config: PerAppConfig): void {
  if (typeof window === "undefined") return;
  try {
    const sanitized: PerAppConfig = {
      launchMode: isLaunchMode(config.launchMode)
        ? config.launchMode
        : DEFAULT_CONFIG.launchMode,
      alwaysOnTop: Boolean(config.alwaysOnTop),
      settings: sanitizeSettings(config.settings),
    };
    window.localStorage.setItem(storageKey(slug), JSON.stringify(sanitized));
  } catch {
    /* ignore — sandboxed storage */
  }
}

export function subscribePerAppConfig(
  slug: string,
  listener: (config: PerAppConfig) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const key = storageKey(slug);
  const handler = (event: StorageEvent): void => {
    if (event.key !== key) return;
    listener(parseConfig(event.newValue));
  };
  window.addEventListener("storage", handler);
  return () => {
    window.removeEventListener("storage", handler);
  };
}

export function getDefaultPerAppConfig(): PerAppConfig {
  return { ...DEFAULT_CONFIG, settings: {} };
}
