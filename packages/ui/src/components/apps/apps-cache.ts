import type { RegistryAppInfo } from "../../api";

const CACHE_KEY = "eliza:apps:catalog:v1";

interface CacheEnvelope {
  cachedAt: number;
  apps: RegistryAppInfo[];
}

function isRegistryAppInfo(value: unknown): value is RegistryAppInfo {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

export function readAppsCache(): RegistryAppInfo[] | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !Array.isArray((parsed as CacheEnvelope).apps)
    ) {
      return null;
    }
    const apps = (parsed as CacheEnvelope).apps.filter(isRegistryAppInfo);
    return apps.length > 0 ? apps : null;
  } catch {
    return null;
  }
}

export function writeAppsCache(apps: RegistryAppInfo[]): void {
  if (typeof window === "undefined") return;
  try {
    const envelope: CacheEnvelope = { cachedAt: Date.now(), apps };
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(envelope));
  } catch {
    /* sandboxed storage — drop silently */
  }
}

export function clearAppsCache(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}
