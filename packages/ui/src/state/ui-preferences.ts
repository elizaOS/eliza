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
 * The default shader base: a warm near-black field (NOT a saturated orange
 * wall). The home reads as a banked ember in a dark room, a deep brown-black
 * substrate the orange glow breathes against, so content stays legible and the
 * accent stays an accent. The old default (#ef5a1f) flooded the whole viewport
 * with bright orange and washed every surface out.
 */
export const DEFAULT_BACKGROUND_COLOR = "#160d07";

/**
 * The ember glow hue the shader layers over {@link DEFAULT_BACKGROUND_COLOR}:
 * the warm orange that gives the dark field its banked-fire warmth without
 * becoming the field itself. Matches the brand accent (`#ff6a1f`). The shader
 * pools this glow low near the composer, so the field reads as a banked ember
 * rather than a flat color wall.
 */
export const DEFAULT_BACKGROUND_GLOW = "#ff6a1f";

/**
 * The shader-mode fallback config: the flat banked-ember field. Kept as the
 * base the color swatches and the glsl fallback resolve to. NOT the boot default
 * anymore — see {@link DEFAULT_BACKGROUND_CONFIG}.
 */
export const DEFAULT_SHADER_BACKGROUND_CONFIG: BackgroundConfig = {
  mode: "shader",
  color: DEFAULT_BACKGROUND_COLOR,
};

/**
 * The curated "Ember Night" gradient as a code-free SVG data URL — the boot
 * default's image source. `gradientDataUrl` is a hoisted function declaration
 * (defined below with the catalog), so calling it here at module-eval time is
 * safe. Kept in sync with the `ember-night` catalog entry's palette.
 */
const EMBER_NIGHT_DATA_URL = gradientDataUrl(["#0a0603", "#160d07", "#3a1f0d"]);

/**
 * The boot default background. #13538 asks the app to boot to "a nice natural
 * (or interesting curated) default, not a flat color." We ship the curated
 * "Ember Night" gradient (a code-free SVG data URL, so it paints instantly with
 * no fetch and no bundled binary).
 */
export const DEFAULT_BACKGROUND_CONFIG: BackgroundConfig = {
  mode: "image",
  color: DEFAULT_BACKGROUND_COLOR,
  imageUrl: EMBER_NIGHT_DATA_URL,
};

/** A named default background — a curated shader color the user can pick. */
export interface BackgroundPreset {
  /** Stable slug used by chat ("use the green background") and tests. */
  id: string;
  /** Human-readable name shown to screen readers and the agent. */
  label: string;
  /** 6-digit hex color driving the shader field. */
  color: string;
}

/**
 * The curated default backgrounds. This is the single source of truth shared by
 * the Background view (swatches) and the agent's BACKGROUND action (so "use the
 * green background" maps to the same color the swatch sets). Each preset is a
 * live, breathing shader field — not a flat fill.
 */
export const BACKGROUND_PRESETS: readonly BackgroundPreset[] = [
  { id: "orange", label: "Orange", color: "#ef5a1f" },
  { id: "amber", label: "Amber", color: "#f59e0b" },
  { id: "rose", label: "Rose", color: "#e11d48" },
  { id: "red", label: "Red", color: "#dc2626" },
  { id: "green", label: "Green", color: "#059669" },
  { id: "olive", label: "Olive", color: "#65a30d" },
  { id: "stone", label: "Stone", color: "#57534e" },
  { id: "graphite", label: "Graphite", color: "#3f3f46" },
  { id: "black", label: "Black", color: "#0a0a0a" },
  { id: "light", label: "Light", color: "#f4f4f5" },
];

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
    // image: a code-free gradient data URL from the palette. Ember Night reuses
    // the shared boot-default URL so the default and its catalog tile match.
    return {
      ...meta,
      source:
        meta.id === SHARED_DEFAULT_BACKGROUND_CATALOG_ID
          ? EMBER_NIGHT_DATA_URL
          : gradientDataUrl(meta.palette),
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
