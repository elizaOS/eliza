/**
 * Types and defaults for persisted UI preferences — theme mode (light/dark/
 * system), shell mode, and the app background config (shader uniforms, image).
 * Owned by useDisplayPreferences; persisted to localStorage.
 */
export type UiTheme = "light" | "dark";

/**
 * User-selectable theme mode. `system` follows the OS `prefers-color-scheme`
 * and resolves to a concrete {@link UiTheme} at apply time. This is the
 * default for new users.
 */
export type UiThemeMode = "light" | "dark" | "system";

export type UiShellMode = "native";

import {
  BACKGROUND_CATALOG_INDEX,
  type BackgroundCatalogKind,
  type BackgroundCatalogMeta,
  DEFAULT_BACKGROUND_CATALOG_ID as SHARED_DEFAULT_BACKGROUND_CATALOG_ID,
} from "@elizaos/shared/backgrounds/catalog-index";
import {
  DEFAULT_SHADER_UNIFORMS,
  normalizeUniforms,
  type ShaderUniformValues,
  uniformsEqual,
} from "../backgrounds/shader-schema";

export type { BackgroundCatalogKind, BackgroundCatalogMeta };

/**
 * How the unified app background is rendered. `shader` paints the animated
 * warm-glow field in a user-chosen color; `image` paints a cover image the
 * user uploaded or generated; `glsl` runs an arbitrary programmable GLSL
 * fragment shader (#10694) with typed, clamped uniforms.
 */
export type BackgroundMode = "shader" | "image" | "glsl";

/** A programmable GLSL background: a fragment shader + its tunable uniforms. */
export interface ShaderConfig {
  /** Preset id when the source came from the library (for the picker/label). */
  presetId?: string;
  /** GLSL ES 1.00 fragment source. */
  source: string;
  /** Tunable uniform values (validated + clamped). */
  uniforms: ShaderUniformValues;
}

/**
 * The user's chosen home/app background. It is read once at the shell root and
 * shared (unchanged) across the home and every view, so navigating never
 * remounts or flashes it. Individual apps/views may paint over it.
 */
export interface BackgroundConfig {
  mode: BackgroundMode;
  /** Base color for the shader field / `u_color` (6-digit hex, e.g. "#ef5a1f"). */
  color: string;
  /** Cover-image source (data URL or `/api/media/…`) when `mode === "image"`. */
  imageUrl?: string;
  /** Programmable shader + uniforms when `mode === "glsl"`. */
  shader?: ShaderConfig;
}

/**
 * The default shader base: pure black. The brand palette is orange / blue /
 * black / white — the field is black so the orange ember glow
 * ({@link DEFAULT_BACKGROUND_GLOW}) reads as the visible app background
 * breathing on top of it, instead of orange-on-orange flat paint. Every
 * persistent host-chrome surface (launch FOUC guard, PWA theme-color,
 * manifest colors) and the native boot splashes track this value so boot
 * never flashes a foreign color and any bleed-through is invisible.
 */
export const DEFAULT_BACKGROUND_COLOR = "#000000";

/**
 * The ember glow hue the shader layers over {@link DEFAULT_BACKGROUND_COLOR}:
 * the warm orange that gives the dark field its banked-fire warmth without
 * becoming the field itself. Matches the brand accent (`#ff6a1f`). The shader
 * pools this glow low near the composer, so the field reads as a banked ember
 * rather than a flat color wall.
 */
export const DEFAULT_BACKGROUND_GLOW = "#ff6a1f";

/**
 * The shader-mode config for the black ember field: the boot default (see
 * {@link DEFAULT_BACKGROUND_CONFIG}) and the base the color swatches and the
 * glsl fallback resolve to.
 */
export const DEFAULT_SHADER_BACKGROUND_CONFIG: BackgroundConfig = {
  mode: "shader",
  color: DEFAULT_BACKGROUND_COLOR,
};

/**
 * The curated "Ember Night" wallpaper: a warm sunset in the clouds, served as
 * a same-origin static asset from `packages/app/public`. It renders the
 * `ember-night` gallery tile (no longer the boot default — the app boots to
 * the brand-orange shader field). A served, code-free, same-origin image the apply
 * channel already trusts (same class as the gradient data URLs and the
 * `/api/media/<hash>` uploads) — it carries no GLSL source or preset id, so the
 * confinement invariants (#11088 / #13523) hold. The bytes live in `public/`
 * (served, cacheable), never in the JS bundle. When the image is cleared or
 * fails to load the shell falls back to the shader field
 * ({@link DEFAULT_SHADER_BACKGROUND_CONFIG}).
 */
const SUNSET_WALLPAPER_URL = "/bg-sunset.webp";

/**
 * The curated photo wallpapers (#14 default-wallpapers): five painterly scenes
 * shipped as compressed WebP static assets from `packages/app/public/
 * wallpapers/`, referenced by a root-relative same-origin URL keyed by catalog
 * id. Same served-asset class as {@link SUNSET_WALLPAPER_URL}: a code-free,
 * same-origin image the apply channel already trusts (no GLSL source, no preset
 * id), so the confinement invariants (#11088 / #13523) hold and the multi-MB
 * bytes live in `public/`, never in the JS bundle (#13538). The renderer routes
 * these through `resolveAppAssetUrl` at paint time (see `ImageBackground`) so a
 * native/standalone shell serving off `file://` / `capacitor://` resolves the
 * same-origin public-asset path against the SPA asset base, not the agent API
 * base (the same URL-resolution trap `resolveTileImageUrl` handles for hero art).
 */
function photoWallpaperUrl(id: string): string {
  return `/wallpapers/${id}.webp`;
}

/** The catalog ids that resolve to a served `/wallpapers/<id>.webp` asset. */
const PHOTO_WALLPAPER_IDS: ReadonlySet<string> = new Set([
  "dusk-dunes",
  "reef",
  "slate",
  "ember-dunes",
  "canopy",
]);

/**
 * The boot default background: the black shader field with the orange ember
 * glow ({@link DEFAULT_SHADER_BACKGROUND_CONFIG}) — not a photo wallpaper.
 * The curated images (Ember Night sunset, photo wallpapers) remain
 * user-selectable gallery options.
 */
export const DEFAULT_BACKGROUND_CONFIG: BackgroundConfig = {
  mode: "shader",
  color: DEFAULT_BACKGROUND_COLOR,
};

/* ── Background catalog (curated + metadata) ──────────────────────────── */

/**
 * How a catalog entry paints. `color` = a shader color field (a preset), `glsl`
 * = a named programmable-shader preset, `image` = a served/vetted cover-image
 * URL (curated gradient data URL, or a persisted `/api/media/<hash>` upload).
 *
 * Note: a catalog entry never carries GLSL *source* — only a `presetId` the
 * renderer resolves against its own shader corpus (#11088). The apply channel
 * enforces this: naming a catalog entry can never smuggle arbitrary shader code
 * or an unvetted client URL through the broker.
 */

/**
 * One entry in the curated background catalog: the shared metadata
 * ({@link BackgroundCatalogMeta} from `@elizaos/shared`) plus the concrete
 * render `source` the renderer attaches (this package is the only place that
 * knows how to paint an entry). The metadata half is the single source of truth
 * the gallery picker AND the agent read; the `source` never crosses the broker.
 */
export interface BackgroundCatalogEntry extends BackgroundCatalogMeta {
  /**
   * The render source (renderer-only, never sent in a payload):
   *  - `kind: "color"` → 6-digit hex driving the shader field.
   *  - `kind: "glsl"`  → a shader preset id (resolved to source by the renderer).
   *  - `kind: "image"` → a served/vetted cover-image URL (gradient data URL or
   *    `/api/media/<hash>`).
   */
  source: string;
  /** Optional generation prompt (for image entries the agent added). */
  prompt?: string;
  /** Optional author ("curated", or an agent/user attribution). */
  author?: string;
}

/**
 * Build a tiny, self-contained SVG gradient as a data URL — a curated "natural"
 * wallpaper with ZERO committed binary bytes. The whole catalog of natural
 * backgrounds is a handful of these (each < 1 KB), so nothing large lands in
 * the bundle (#13538 constraint) and every entry is a same-origin, code-free
 * image the apply channel already trusts.
 */
function gradientDataUrl(palette: readonly string[]): string {
  const [a, b, c] = [
    palette[0] ?? DEFAULT_BACKGROUND_COLOR,
    palette[1] ?? palette[0] ?? DEFAULT_BACKGROUND_COLOR,
    palette[2] ?? palette[palette.length - 1] ?? DEFAULT_BACKGROUND_COLOR,
  ];
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='16' height='24' ` +
    `preserveAspectRatio='xMidYMid slice' viewBox='0 0 16 24'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='0' y2='1'>` +
    `<stop offset='0' stop-color='${a}'/>` +
    `<stop offset='0.55' stop-color='${b}'/>` +
    `<stop offset='1' stop-color='${c}'/>` +
    `</linearGradient></defs>` +
    `<rect width='16' height='24' fill='url(#g)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/**
 * Attach a concrete render `source` to each shared metadata entry, building the
 * full catalog the gallery + apply channel use. Natural images become code-free
 * gradient data URLs (from the entry's palette); glsl entries carry the preset
 * id as `source` (resolved to GLSL by the renderer, never text here). This is
 * the ONLY place a catalog id becomes something paintable.
 */
export const BACKGROUND_CATALOG: readonly BackgroundCatalogEntry[] =
  BACKGROUND_CATALOG_INDEX.map((meta): BackgroundCatalogEntry => {
    if (meta.kind === "glsl") {
      // `source` is the preset id; the renderer resolves it to GLSL.
      return { ...meta, source: meta.id, author: "curated" };
    }
    if (meta.kind === "color") {
      return {
        ...meta,
        source:
          meta.palette[meta.palette.length - 1] ?? DEFAULT_BACKGROUND_COLOR,
        author: "curated",
      };
    }
    // image: a served same-origin asset for the default (the sunset wallpaper)
    // and for each curated photo wallpaper (a `/wallpapers/<id>.webp` static
    // asset); a code-free gradient data URL from the palette for the rest. Ember
    // Night reuses the shared boot-default URL so the default and its catalog
    // tile match ({@link DEFAULT_BACKGROUND_CONFIG}).
    const source =
      meta.id === SHARED_DEFAULT_BACKGROUND_CATALOG_ID
        ? SUNSET_WALLPAPER_URL
        : PHOTO_WALLPAPER_IDS.has(meta.id)
          ? photoWallpaperUrl(meta.id)
          : gradientDataUrl(meta.palette);
    return {
      ...meta,
      source,
      author: "curated",
    };
  });

/**
 * The curated natural (image) catalog entries — the gallery leads with these.
 */
export const CURATED_NATURAL_BACKGROUNDS: readonly BackgroundCatalogEntry[] =
  BACKGROUND_CATALOG.filter((e) => e.kind === "image");

/** The animated GLSL catalog entries, mirrored from the shader preset library. */
export const GLSL_CATALOG_BACKGROUNDS: readonly BackgroundCatalogEntry[] =
  BACKGROUND_CATALOG.filter((e) => e.kind === "glsl");

/** The boot-default catalog id (re-exported from the shared index). */
export const DEFAULT_BACKGROUND_CATALOG_ID =
  SHARED_DEFAULT_BACKGROUND_CATALOG_ID;

/**
 * Normalize a free-text / id / label reference to a catalog entry. Case- and
 * whitespace-insensitive; matches by id first, then exact label, then a label
 * substring (either direction) — so "misty forest", "Misty Forest", and "the
 * misty forest one" all resolve. Returns undefined for an unknown name (the
 * apply channel then ignores it — consistent with the #13523 confinement rule
 * that unknown/hostile payloads never wedge the background).
 *
 * Deliberately does NOT match on generic tags ("green"/"blue"/"warm"): those are
 * color words owned by the color parser — tag-matching them would apply an
 * arbitrary curated image for a plain color request.
 */
export function resolveCatalogEntry(
  ref: string | undefined,
): BackgroundCatalogEntry | undefined {
  if (!ref) return undefined;
  const needle = ref.trim().toLowerCase();
  if (!needle) return undefined;
  const byId = BACKGROUND_CATALOG.find((e) => e.id === needle);
  if (byId) return byId;
  const byLabel = BACKGROUND_CATALOG.find(
    (e) => e.label.toLowerCase() === needle,
  );
  if (byLabel) return byLabel;
  return BACKGROUND_CATALOG.find((e) => {
    const label = e.label.toLowerCase();
    return label.includes(needle) || needle.includes(label);
  });
}

/**
 * Resolve a catalog entry to a concrete `BackgroundConfig`. Color/image entries
 * map directly; a glsl entry is resolved to its shader source by the provided
 * `resolveShaderSource` (the renderer's `getShaderPreset`) — the catalog itself
 * never carries GLSL text (#11088). Returns undefined when a glsl entry's preset
 * can't be resolved, so a stale/unknown preset id never wedges the background.
 */
export function catalogEntryToConfig(
  entry: BackgroundCatalogEntry,
  resolveShaderSource: (presetId: string) => string | undefined,
): BackgroundConfig | undefined {
  if (entry.kind === "color") {
    return { mode: "shader", color: entry.source };
  }
  if (entry.kind === "image") {
    return {
      mode: "image",
      color: DEFAULT_BACKGROUND_COLOR,
      imageUrl: entry.source,
    };
  }
  const source = resolveShaderSource(entry.source);
  if (!source) return undefined;
  return makeGlslConfig({ source, presetId: entry.source });
}

/** Structural equality for two background configs (skips history no-ops). */
export function backgroundConfigsEqual(
  a: BackgroundConfig,
  b: BackgroundConfig,
): boolean {
  return (
    a.mode === b.mode &&
    a.color === b.color &&
    (a.imageUrl ?? "") === (b.imageUrl ?? "") &&
    shaderConfigsEqual(a.shader, b.shader)
  );
}

function shaderConfigsEqual(a?: ShaderConfig, b?: ShaderConfig): boolean {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.source === b.source &&
    (a.presetId ?? "") === (b.presetId ?? "") &&
    uniformsEqual(a.uniforms, b.uniforms)
  );
}

/* ── Accent color presets ─────────────────────────────────────────────── */

/**
 * The default accent id — keeps the app's built-in brand accent (orange) by
 * applying no `--accent` override, so base.css / the host brand theme wins.
 */
export const DEFAULT_ACCENT_ID = "default";

/**
 * A named accent color the user can pick for the app's `--accent` token. The
 * `default` preset carries `color: null` (clears the override → brand accent).
 * Kept to the app's curated warm/neutral palette — never blue (brand rule
 * #8796).
 */
export interface AccentPreset {
  /** Stable slug persisted + used by onboarding + Appearance settings. */
  id: string;
  /** Human-readable name shown on the swatch and to screen readers. */
  label: string;
  /**
   * 6-digit hex applied to `--accent` (+ derived tokens), or `null` for the
   * built-in brand accent.
   */
  color: string | null;
  /** Emoji swatch used where only text labels render (in-chat onboarding). */
  swatch: string;
}

/**
 * The curated accent choices. Single source of truth shared by the Appearance
 * settings swatches and the first-run onboarding accent step, so both drive the
 * exact same persisted preference.
 */
export const ACCENT_PRESETS: readonly AccentPreset[] = [
  { id: "default", label: "Eliza Orange", color: null, swatch: "🟠" },
  { id: "amber", label: "Amber", color: "#f59e0b", swatch: "🟡" },
  { id: "rose", label: "Rose", color: "#e11d48", swatch: "🌹" },
  { id: "red", label: "Red", color: "#dc2626", swatch: "🔴" },
  { id: "green", label: "Green", color: "#059669", swatch: "🟢" },
  { id: "olive", label: "Olive", color: "#65a30d", swatch: "🫒" },
];

/** Coerce an unknown persisted value to a valid accent id (default fallback). */
export function normalizeAccentId(value: unknown): string {
  return typeof value === "string" && ACCENT_PRESETS.some((p) => p.id === value)
    ? value
    : DEFAULT_ACCENT_ID;
}

/**
 * Resolve an accent id to its hex color, or `null` for the built-in brand
 * accent (the `default` preset, or any unknown id).
 */
export function resolveAccentColor(id: string): string | null {
  return ACCENT_PRESETS.find((p) => p.id === id)?.color ?? null;
}

/** Build a normalized glsl `BackgroundConfig` from a shader source + partials.
 * `uniforms` accepts unknown-valued partials (agent/persisted input);
 * `normalizeUniforms` clamps + coerces them to finite numbers. */
export function makeGlslConfig(args: {
  source: string;
  color?: string;
  presetId?: string;
  uniforms?: Partial<Record<keyof ShaderUniformValues, unknown>>;
}): BackgroundConfig {
  return {
    mode: "glsl",
    color: args.color ?? DEFAULT_BACKGROUND_COLOR,
    shader: {
      presetId: args.presetId,
      source: args.source,
      uniforms: normalizeUniforms({
        ...DEFAULT_SHADER_UNIFORMS,
        ...(args.uniforms ?? {}),
      }),
    },
  };
}
