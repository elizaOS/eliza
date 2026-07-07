/**
 * The USER background catalog (#13538) — backgrounds the agent generated/uploaded
 * and named into the catalog, plus any the user saved from the gallery's
 * "add to catalog" affordance. Kept separate from the curated `BACKGROUND_CATALOG`
 * (which is compile-time + code-free) so:
 *
 *  - the curated set stays a small, static, code-free source of truth, and
 *  - user entries persist to localStorage WITHOUT a new server file store
 *    (#8876: no second media store) — the image itself is already re-hosted to
 *    `/api/media/<hash>` by the existing background routes, so a user entry only
 *    persists a short URL + metadata, never bytes.
 *
 * Security: a user entry is ALWAYS `kind: "image"` with a SERVED media-store URL
 * (`/api/media/<hash>`). It can never carry GLSL source or a preset id, so the
 * confinement invariants (#11088 / #13523) are unaffected — the apply channel
 * treats a resolved user entry exactly like any other image config.
 *
 * Quota: inline `data:` URLs are deliberately REJECTED from the persisted
 * catalog. A re-hosted upload is a tiny `/api/media/<hash>` reference; the
 * offline/serverless fallback keeps a multi-MB data URL live on the CURRENT
 * background (that still works), but persisting up to 24 of those would blow
 * localStorage — the same hazard `normalizeBackgroundHistory` caps to 1 data URL
 * for the undo stack. So a data-URL upload simply isn't saved to the catalog.
 */

import { shellLocalStorage } from "../surface-realm-channel";
import type { BackgroundCatalogEntry } from "./ui-preferences";

const USER_BACKGROUND_CATALOG_KEY = "eliza:ui-background-user-catalog";

/** Cap the persisted user catalog so it never grows localStorage without bound. */
const MAX_USER_CATALOG_ENTRIES = 24;

function tryLocalStorage<T>(fn: () => T, fallback: T): T {
  try {
    return fn();
  } catch {
    return fallback;
  }
}

/** Coerce one unknown persisted record to a valid image catalog entry, or null. */
function normalizeUserEntry(value: unknown): BackgroundCatalogEntry | null {
  if (!value || typeof value !== "object") return null;
  const r = value as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id : "";
  const source = typeof r.source === "string" ? r.source : "";
  // A user entry is only ever a SERVED media-store URL. Inline data URLs are
  // rejected (quota hazard) and GLSL/preset sources are never image entries.
  const okUrl = source.startsWith("/api/media/");
  if (!id || !okUrl) return null;
  const palette = Array.isArray(r.palette)
    ? r.palette.filter((c): c is string => typeof c === "string").slice(0, 4)
    : [];
  const tags = Array.isArray(r.tags)
    ? r.tags.filter((t): t is string => typeof t === "string").slice(0, 8)
    : [];
  return {
    id,
    label: typeof r.label === "string" && r.label ? r.label : id,
    description:
      typeof r.description === "string" ? r.description : "A saved background.",
    kind: "image",
    source,
    mood: typeof r.mood === "string" ? r.mood : "custom",
    palette,
    tags: tags.length > 0 ? tags : ["custom"],
    prompt: typeof r.prompt === "string" ? r.prompt : undefined,
    author: typeof r.author === "string" ? r.author : "you",
  };
}

/** The persisted user catalog (newest first). Empty on any read failure. */
export function loadUserBackgroundCatalog(): BackgroundCatalogEntry[] {
  return tryLocalStorage(() => {
    const raw = localStorage.getItem(USER_BACKGROUND_CATALOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: BackgroundCatalogEntry[] = [];
    for (const entry of parsed) {
      const norm = normalizeUserEntry(entry);
      if (norm) out.push(norm);
    }
    return out.slice(0, MAX_USER_CATALOG_ENTRIES);
  }, []);
}

function saveUserBackgroundCatalog(entries: BackgroundCatalogEntry[]): void {
  tryLocalStorage(() => {
    shellLocalStorage.setItem(
      USER_BACKGROUND_CATALOG_KEY,
      JSON.stringify(entries.slice(0, MAX_USER_CATALOG_ENTRIES)),
    );
  }, undefined);
}

/**
 * Add (or update by id) a user catalog entry, newest first, and persist it.
 * Rejects anything but a served/vetted image URL (returns the unchanged list),
 * so a hostile/malformed entry can never enter the catalog. Returns the new
 * list so callers can re-render.
 */
export function addUserBackgroundEntry(
  entry: BackgroundCatalogEntry,
): BackgroundCatalogEntry[] {
  const norm = normalizeUserEntry(entry);
  if (!norm) return loadUserBackgroundCatalog();
  const existing = loadUserBackgroundCatalog().filter((e) => e.id !== norm.id);
  const next = [norm, ...existing].slice(0, MAX_USER_CATALOG_ENTRIES);
  saveUserBackgroundCatalog(next);
  return next;
}

export { MAX_USER_CATALOG_ENTRIES, USER_BACKGROUND_CATALOG_KEY };
