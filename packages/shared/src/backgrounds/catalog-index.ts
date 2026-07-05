/**
 * The background-catalog NAME INDEX — the shared, code-free metadata half of the
 * curated background catalog (#13538). It lives in `@elizaos/shared` so BOTH
 * halves read one source of truth:
 *
 *  - `@elizaos/ui` (`state/ui-preferences.ts`) imports this index and attaches
 *    the concrete render sources (gradient data URLs / shader preset ids) to
 *    build `BACKGROUND_CATALOG` for the gallery + the apply channel.
 *  - `@elizaos/plugin-app-control` (the `BACKGROUND` action) imports this index
 *    to MATCH a user's request ("use the misty-forest background") to a catalog
 *    id, then names that id in the `background:apply` payload (`catalogId`).
 *
 * Crucially this index carries NO render source — no GLSL text, no image bytes,
 * no URL. It is pure metadata (id / label / description / mood / palette /
 * tags). The renderer is the only place that resolves an id to something
 * paintable, so naming a catalog entry can never smuggle code or an unvetted
 * URL across the broker (#11088 / #13523).
 */

/** How a catalog entry ultimately renders (the renderer owns the source). */
export type BackgroundCatalogKind = "color" | "glsl" | "image";

/** Pure metadata for one curated background — no render source. */
export interface BackgroundCatalogMeta {
  /** Stable slug used by the gallery, chat name-select, and tests. */
  id: string;
  /** Human-readable name (screen readers + the agent reply). */
  label: string;
  /** One-line description the agent can read to describe/pick the option. */
  description: string;
  /** How this entry renders (the renderer resolves the actual source). */
  kind: BackgroundCatalogKind;
  /** Short mood word(s) ("calm", "vivid"). */
  mood: string;
  /** Representative palette (hex) for the tile thumbnail + agent context. */
  palette: readonly string[];
  /** Search/agent tags ("nature", "forest", "warm"). */
  tags: readonly string[];
}

/**
 * The curated natural-background metadata. The renderer attaches a code-free SVG
 * gradient data URL to each of these (keyed by id).
 */
export const NATURAL_BACKGROUND_META: readonly BackgroundCatalogMeta[] = [
  {
    id: "misty-forest",
    label: "Misty Forest",
    description: "Soft green haze fading into a deep evergreen floor.",
    kind: "image",
    mood: "calm",
    palette: ["#0d1f16", "#1f3d2b", "#3a5a3f"],
    tags: ["nature", "forest", "green", "calm"],
  },
  {
    id: "desert-dusk",
    label: "Desert Dusk",
    description: "Warm sand rising into a burnt-amber twilight sky.",
    kind: "image",
    mood: "warm",
    palette: ["#2a160c", "#7a3b1a", "#c76a2b"],
    tags: ["nature", "desert", "warm", "sunset"],
  },
  {
    id: "ocean-deep",
    label: "Ocean Deep",
    description: "Teal surface light dissolving into the abyssal blue.",
    kind: "image",
    mood: "cool",
    palette: ["#04121c", "#0b3550", "#127a8c"],
    tags: ["nature", "ocean", "water", "blue", "cool"],
  },
  {
    id: "alpine-dawn",
    label: "Alpine Dawn",
    description: "Cold slate peaks catching the first rose of sunrise.",
    kind: "image",
    mood: "serene",
    palette: ["#151a26", "#3a3f57", "#b56a6a"],
    tags: ["nature", "mountain", "dawn", "serene"],
  },
  {
    id: "ember-night",
    label: "Ember Night",
    description: "A banked-fire glow low against a deep brown-black field.",
    kind: "image",
    mood: "cozy",
    palette: ["#0a0603", "#160d07", "#3a1f0d"],
    tags: ["warm", "ember", "dark", "cozy"],
  },
];

/**
 * The named GLSL-preset metadata, mirrored as catalog entries. `id` doubles as
 * the shader preset id the renderer resolves to source (never GLSL text here).
 */
export const GLSL_BACKGROUND_META: readonly BackgroundCatalogMeta[] = [
  {
    id: "aurora",
    label: "Aurora",
    description: "Slow ribbons of light drifting like the northern lights.",
    kind: "glsl",
    mood: "dreamy",
    palette: ["#0a2a2f", "#1f6f6a", "#8be0c0"],
    tags: ["animated", "aurora", "green"],
  },
  {
    id: "lava",
    label: "Lava",
    description: "Molten cells churning in a dark volcanic field.",
    kind: "glsl",
    mood: "intense",
    palette: ["#1a0603", "#7a2410", "#f05a1f"],
    tags: ["animated", "lava", "fire", "warm"],
  },
  {
    id: "plasma",
    label: "Plasma",
    description: "A shifting psychedelic plasma of interleaved color.",
    kind: "glsl",
    mood: "vivid",
    palette: ["#2a0a3a", "#7a1f8c", "#e05aa0"],
    tags: ["animated", "plasma", "psychedelic"],
  },
  {
    id: "waves",
    label: "Waves",
    description: "Gentle rolling ocean swells under a low light.",
    kind: "glsl",
    mood: "soothing",
    palette: ["#04121c", "#0b3550", "#3a8ca0"],
    tags: ["animated", "waves", "ocean", "cool"],
  },
  {
    id: "nebula",
    label: "Nebula",
    description: "Cosmic clouds of dust and starlight drifting in space.",
    kind: "glsl",
    mood: "expansive",
    palette: ["#05060f", "#241f4a", "#7a6ad0"],
    tags: ["animated", "nebula", "space", "cosmic"],
  },
];

/**
 * The full catalog name index: natural images first, then the animated GLSL
 * presets. Both the gallery (via `@elizaos/ui`) and the agent action read this.
 */
export const BACKGROUND_CATALOG_INDEX: readonly BackgroundCatalogMeta[] = [
  ...NATURAL_BACKGROUND_META,
  ...GLSL_BACKGROUND_META,
];

/** The boot-default catalog id (the curated "Ember Night" gradient). */
export const DEFAULT_BACKGROUND_CATALOG_ID = "ember-night";

/**
 * Match a free-text / id / label reference to a catalog id. Case- and
 * whitespace-insensitive; matches by id, then exact label, then a label
 * substring (either direction). So "misty forest", "Misty Forest", "the misty
 * forest one", and "misty-forest" all resolve. Returns undefined for an unknown
 * name (callers then ignore it — consistent with the #13523 confinement rule).
 *
 * Deliberately does NOT match on generic tags ("green", "blue", "warm"): those
 * are color-like words that belong to the color parser, and tag-matching them
 * would apply an arbitrary curated image for a plain color request.
 */
export function matchCatalogId(ref: string | undefined): string | undefined {
  if (!ref) return undefined;
  const needle = ref.trim().toLowerCase();
  if (!needle) return undefined;
  const byId = BACKGROUND_CATALOG_INDEX.find((e) => e.id === needle);
  if (byId) return byId.id;
  const byLabel = BACKGROUND_CATALOG_INDEX.find(
    (e) => e.label.toLowerCase() === needle,
  );
  if (byLabel) return byLabel.id;
  const byLabelPart = BACKGROUND_CATALOG_INDEX.find((e) => {
    const label = e.label.toLowerCase();
    return label.includes(needle) || needle.includes(label);
  });
  return byLabelPart?.id;
}

/**
 * Detect whether free text names a curated NATURAL (image) catalog background,
 * returning the matched id. Only the natural entries are matched here: the GLSL
 * presets (aurora/lava/…) already have a dedicated shader-preset path in the
 * BACKGROUND action, so routing them through name-select would change their
 * reply/behavior. Requires a distinctive label/id token to appear (not a generic
 * tag like "warm"/"green"), so a plain color request is never hijacked. Used by
 * the action to route "use the misty-forest background" to a name-select.
 */
export function detectCatalogId(text: string): string | undefined {
  const lower = text.toLowerCase();
  for (const entry of NATURAL_BACKGROUND_META) {
    const slug = entry.id; // e.g. "misty-forest"
    const spaced = slug.replace(/-/g, " "); // "misty forest"
    const label = entry.label.toLowerCase(); // "misty forest"
    if (
      lower.includes(slug) ||
      lower.includes(spaced) ||
      lower.includes(label)
    ) {
      return entry.id;
    }
  }
  return undefined;
}
