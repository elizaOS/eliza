// Typed localStorage shim (ported from odysseus static/js/storage.js intent):
// a single namespaced accessor so UI prefs (sidebar width, density, collapsed
// rail, think-block expansion) survive reloads without scattering raw
// localStorage calls. SSR/Node-safe — guards on `window`.

const NS = "odysseus:";

export function readPref<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(NS + key);
    if (raw == null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    // quota / disabled storage — prefs are best-effort, never fatal.
  }
}

export const PREF_KEYS = {
  sidebarCollapsed: "sidebar-collapsed",
  density: "density",
  activeThread: "active-thread",
  themeMode: "theme-mode",
  font: "font",
  customTheme: "custom-theme",
  notes: "notes",
  bgPattern: "bg-pattern",
  customThemes: "custom-themes",
} as const;
