/**
 * Content Pack manifest and types.
 *
 * A content pack bundles visual assets (VRM, background, color scheme),
 * personality data, and optional stream overlay into a single installable unit.
 * Packs are loaded from the splash page before onboarding begins.
 */

import type { ThemeDefinition } from "./theme.js";

// ── Manifest ────────────────────────────────────────────────────────

export interface ContentPackManifest {
  /** Unique pack identifier (kebab-case, e.g. "cyberpunk-neon") */
  id: string;
  /** Human-readable display name */
  name: string;
  /** Semantic version */
  version: string;
  /** Optional author or creator name */
  author?: string;
  /** Short description shown in the pack browser */
  description?: string;
  /** Preview image filename (relative to pack root) */
  preview?: string;
  /** Asset declarations — all fields are optional */
  assets: ContentPackAssets;
}

export interface ContentPackAssets {
  /** VRM avatar model */
  vrm?: ContentPackVrmAsset;
  /** Background image filename (relative to pack root) */
  background?: string;
  /** Gaussian splat companion world scene filename */
  world?: string;
  /** Color scheme overrides (narrow — 6 color fields) */
  colorScheme?: ContentPackColorScheme;
  /**
   * Full theme definition (light + dark palettes, fonts, radii, etc.).
   * Takes precedence over colorScheme when present.
   */
  theme?: ThemeDefinition;
  /** Stream overlay directory (relative to pack root) */
  streamOverlay?: string;
  /** Personality definition (subset of StylePreset) */
  personality?: ContentPackPersonality;
}

export interface ContentPackVrmAsset {
  /** VRM file path (relative to pack root, typically .vrm or .vrm.gz) */
  file: string;
  /** Preview thumbnail path (relative to pack root) */
  preview?: string;
  /** Slug used for URL resolution */
  slug: string;
}

export interface ContentPackColorScheme {
  /** Primary accent color (hex) */
  accent?: string;
  /** Background color (hex) */
  bg?: string;
  /** Card/surface color (hex) */
  card?: string;
  /** Border color (hex) */
  border?: string;
  /** Text color (hex) */
  text?: string;
  /** Muted text color (hex) */
  textMuted?: string;
  /** Additional CSS custom properties (key without --prefix, value) */
  customProperties?: Record<string, string>;
}

export interface ContentPackPersonality {
  /** Character display name */
  name?: string;
  /** Bio lines */
  bio?: string[];
  /**
   * System prompt override.
   *
   * SECURITY: intentionally deferred — not wired in applyContentPack().
   * A remote pack controlling the agent's system prompt is significant
   * attack surface. Wiring this requires the same trust/review enforcement
   * as other prompt sources (character editor, config file).
   */
  system?: string;
  /** Catchphrase shown during onboarding */
  catchphrase?: string;
  /** Adjectives describing the character */
  adjectives?: string[];
  /** Voice preset ID (e.g. "alice", "brian") */
  voicePresetId?: string;
  /** Greeting animation filename */
  greetingAnimation?: string;
}

// ── Resolved Pack ───────────────────────────────────────────────────
// After loading, asset paths are resolved to absolute URLs.

export interface ResolvedContentPack {
  manifest: ContentPackManifest;
  /** Absolute URL or data URL for the VRM model (custom packs) */
  vrmUrl?: string;
  /** Bundled avatar index (1-8) — used instead of vrmUrl for built-in characters */
  avatarIndex?: number;
  /** Absolute URL for the VRM preview thumbnail */
  vrmPreviewUrl?: string;
  /** Absolute URL for the background image */
  backgroundUrl?: string;
  /** Absolute URL for the companion world scene */
  worldUrl?: string;
  /** Resolved color scheme (same shape, just validated) */
  colorScheme?: ContentPackColorScheme;
  /** Absolute path to stream overlay directory */
  streamOverlayPath?: string;
  /** Validated personality data */
  personality?: ContentPackPersonality;
  /** Where the pack was loaded from */
  source: ContentPackSource;
}

export type ContentPackSource =
  | { kind: "bundled"; id: string }
  | { kind: "file"; path: string }
  | { kind: "url"; url: string };

// ── Validation ──────────────────────────────────────────────────────

const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{3,8}$/;

export interface ContentPackValidationError {
  field: string;
  message: string;
}

export function validateContentPackManifest(
  data: unknown,
): ContentPackValidationError[] {
  const errors: ContentPackValidationError[] = [];
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    errors.push({ field: "root", message: "Manifest must be a JSON object" });
    return errors;
  }

  const manifest = data as Record<string, unknown>;

  // Required fields
  if (typeof manifest.id !== "string" || !manifest.id.trim()) {
    errors.push({ field: "id", message: "Pack id is required" });
  } else if (!PACK_ID_PATTERN.test(manifest.id)) {
    errors.push({
      field: "id",
      message:
        "Pack id must be kebab-case (lowercase letters, numbers, hyphens)",
    });
  }

  if (typeof manifest.name !== "string" || !manifest.name.trim()) {
    errors.push({ field: "name", message: "Pack name is required" });
  }

  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    errors.push({ field: "version", message: "Pack version is required" });
  }

  // Assets validation
  const assets =
    manifest.assets && typeof manifest.assets === "object"
      ? (manifest.assets as Record<string, unknown>)
      : null;

  if (!assets) {
    errors.push({ field: "assets", message: "Assets object is required" });
    return errors;
  }

  // VRM validation
  if (assets.vrm != null) {
    const vrm =
      typeof assets.vrm === "object" && !Array.isArray(assets.vrm)
        ? (assets.vrm as Record<string, unknown>)
        : null;
    if (!vrm) {
      errors.push({ field: "assets.vrm", message: "VRM must be an object" });
    } else {
      if (typeof vrm.file !== "string" || !vrm.file.trim()) {
        errors.push({
          field: "assets.vrm.file",
          message: "VRM file path is required",
        });
      }
      if (typeof vrm.slug !== "string" || !vrm.slug.trim()) {
        errors.push({
          field: "assets.vrm.slug",
          message: "VRM slug is required",
        });
      }
    }
  }

  // Color scheme validation
  if (assets.colorScheme != null) {
    const cs =
      typeof assets.colorScheme === "object" &&
      !Array.isArray(assets.colorScheme)
        ? (assets.colorScheme as Record<string, unknown>)
        : null;
    if (!cs) {
      errors.push({
        field: "assets.colorScheme",
        message: "Color scheme must be an object",
      });
    } else {
      for (const key of [
        "accent",
        "bg",
        "card",
        "border",
        "text",
        "textMuted",
      ] as const) {
        if (
          typeof cs[key] === "string" &&
          !HEX_COLOR_PATTERN.test(cs[key] as string)
        ) {
          errors.push({
            field: `assets.colorScheme.${key}`,
            message: `Color value must be a valid hex color (e.g. #ff00ff)`,
          });
        }
      }
    }
  }

  return errors;
}

// ── Constants ───────────────────────────────────────────────────────

/** Manifest filename expected at the root of a content pack */
export const CONTENT_PACK_MANIFEST_FILENAME = "pack.json";

/** Maximum pack file size (100 MB) */
export const CONTENT_PACK_MAX_SIZE_BYTES = 100 * 1024 * 1024;
