/**
 * Branded hero-image generator for plugin **views**.
 *
 * A view is a mini-app contributed by a plugin (`Plugin.views`). Each one is
 * served a square hero image at `/api/views/<id>/hero`. Real heroes live in the
 * plugin at `assets/hero.<ext>`; when a plugin ships none, the agent serves a
 * generated SVG produced here so the catalog never shows a broken or ugly tile.
 *
 * The composition is intentionally **no-blue-dominant** (the app surface forbids
 * blue accents — orange/jewel tones only) and **deterministic**: the same input
 * always yields byte-identical output, so `scripts/generate-view-heroes.mjs`
 * (which commits real heroes into plugins) and the runtime fallback render the
 * exact same art. This is the single source of truth for that art — the script
 * and the agent both import `renderViewHeroSvg` from here.
 *
 * Pure string generation only: no Node APIs, so this module stays importable
 * from the runtime-agnostic `@elizaos/shared` barrel (browser + server).
 */

const W = 1024;
const CX = W / 2;

/**
 * Convert an HSL triple to a hex color string. Deterministic, no rounding
 * surprises across runs.
 */
function hsl(h: number, s: number, l: number): string {
  const sN = s / 100;
  const lN = l / 100;
  const c = (1 - Math.abs(2 * lN - 1)) * sN;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp >= 0 && hp < 1) [r, g, b] = [c, x, 0];
  else if (hp < 2) [r, g, b] = [x, c, 0];
  else if (hp < 3) [r, g, b] = [0, c, x];
  else if (hp < 4) [r, g, b] = [0, x, c];
  else if (hp < 5) [r, g, b] = [x, 0, c];
  else [r, g, b] = [c, 0, x];
  const m = lN - c / 2;
  const toHex = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * A palette derived from a single accent hue, kept in a dark, modern register.
 * Background tones are deep neutrals shifted slightly toward the accent so each
 * card reads distinct without ever looking like a flat blue panel.
 */
function palette(hue: number) {
  return {
    bgTop: hsl(hue, 32, 12),
    bgBottom: hsl(hue + 14, 40, 7),
    blobA: hsl(hue, 70, 52),
    blobB: hsl(hue + 28, 66, 46),
    accent: hsl(hue, 82, 60),
    accentSoft: hsl(hue, 70, 70),
    line: hsl(hue, 30, 88),
  };
}

export interface ViewHeroFrameInput {
  /** Stable slug used to namespace SVG gradient/filter ids. */
  id: string;
  /** Accent hue (0–359). Keep out of the pure-blue band for the app surface. */
  hue: number;
  /** Inline SVG markup for the centered line-icon glyph. */
  iconSvg: string;
  /** Display label rendered along the bottom. */
  label: string;
}

/**
 * Render the full branded hero SVG. Shared chrome (defs, background, depth
 * blobs, faint grid, accent arc, bottom label + vignette) with the icon glyph
 * slotted in. Output is deterministic and byte-identical for identical input.
 */
export function renderViewHeroSvg({
  id,
  hue,
  iconSvg,
  label,
}: ViewHeroFrameInput): string {
  const p = palette(hue);
  const safeLabel = escapeXml(label);
  // Two large blurred blobs placed off-center for asymmetric depth, plus a thin
  // accent arc sweeping behind the icon.
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" width="${W}" height="${W}" role="img" aria-label="${safeLabel}">
  <defs>
    <linearGradient id="bg-${id}" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${p.bgTop}"/>
      <stop offset="1" stop-color="${p.bgBottom}"/>
    </linearGradient>
    <radialGradient id="blobA-${id}" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${p.blobA}" stop-opacity="0.55"/>
      <stop offset="1" stop-color="${p.blobA}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="blobB-${id}" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0" stop-color="${p.blobB}" stop-opacity="0.5"/>
      <stop offset="1" stop-color="${p.blobB}" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="vig-${id}" cx="0.5" cy="0.42" r="0.75">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="0.72" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.5"/>
    </radialGradient>
    <linearGradient id="label-${id}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#000000" stop-opacity="0"/>
      <stop offset="1" stop-color="#000000" stop-opacity="0.55"/>
    </linearGradient>
    <filter id="soft-${id}" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="46"/>
    </filter>
    <filter id="iglow-${id}" x="-40%" y="-40%" width="180%" height="180%">
      <feDropShadow dx="0" dy="0" stdDeviation="14" flood-color="${p.accent}" flood-opacity="0.45"/>
    </filter>
  </defs>

  <rect width="${W}" height="${W}" fill="url(#bg-${id})"/>

  <g opacity="0.9">
    <circle cx="232" cy="220" r="300" fill="url(#blobA-${id})" filter="url(#soft-${id})"/>
    <circle cx="840" cy="800" r="340" fill="url(#blobB-${id})" filter="url(#soft-${id})"/>
  </g>

  <g stroke="${p.line}" stroke-width="1.4" opacity="0.06">
    <line x1="0" y1="256" x2="${W}" y2="256"/>
    <line x1="0" y1="512" x2="${W}" y2="512"/>
    <line x1="0" y1="768" x2="${W}" y2="768"/>
    <line x1="256" y1="0" x2="256" y2="${W}"/>
    <line x1="512" y1="0" x2="512" y2="${W}"/>
    <line x1="768" y1="0" x2="768" y2="${W}"/>
  </g>

  <g opacity="0.5">
    <path d="M120 470 A 400 400 0 0 1 904 470" fill="none" stroke="${p.accent}" stroke-width="3" opacity="0.35"/>
  </g>

  <g transform="translate(${CX} 432)" filter="url(#iglow-${id})"
     color="${p.line}" stroke="${p.line}" stroke-width="20"
     stroke-linecap="round" stroke-linejoin="round" fill="none">
${iconSvg}
  </g>

  <rect x="0" y="784" width="${W}" height="240" fill="url(#label-${id})"/>
  <text x="${CX}" y="892" text-anchor="middle"
        font-family="system-ui, -apple-system, Segoe UI, Roboto, sans-serif"
        font-size="76" font-weight="600" letter-spacing="0.5"
        fill="${p.line}">${safeLabel}</text>
  <rect x="${CX - 52}" y="924" width="104" height="6" rx="3" fill="${p.accent}"/>

  <rect width="${W}" height="${W}" fill="url(#vig-${id})"/>
</svg>`;
}

/**
 * Hand-drawn vector line-icons, centered at (0,0) spanning roughly -150..150.
 * Each inherits stroke styling from the parent <g>; fills are set explicitly
 * where a filled glyph reads better. Keyed names map to the catalog below.
 */
export const VIEW_HERO_ICONS = {
  // cpu / chip with a beaker spark — Model Tester
  modelTester: `    <rect x="-110" y="-110" width="220" height="220" rx="28"/>
    <rect x="-58" y="-58" width="116" height="116" rx="14"/>
    <line x1="-110" y1="-66" x2="-150" y2="-66"/>
    <line x1="-110" y1="0" x2="-150" y2="0"/>
    <line x1="-110" y1="66" x2="-150" y2="66"/>
    <line x1="110" y1="-66" x2="150" y2="-66"/>
    <line x1="110" y1="0" x2="150" y2="0"/>
    <line x1="110" y1="66" x2="150" y2="66"/>
    <line x1="-66" y1="-110" x2="-66" y2="-150"/>
    <line x1="0" y1="-110" x2="0" y2="-150"/>
    <line x1="66" y1="-110" x2="66" y2="-150"/>
    <line x1="-66" y1="110" x2="-66" y2="150"/>
    <line x1="0" y1="110" x2="0" y2="150"/>
    <line x1="66" y1="110" x2="66" y2="150"/>
    <circle cx="0" cy="0" r="14" stroke-width="0" fill="currentColor"/>`,

  // overlapping panels — Views (layout grid)
  views: `    <rect x="-150" y="-150" width="130" height="130" rx="18"/>
    <rect x="20" y="-150" width="130" height="130" rx="18"/>
    <rect x="-150" y="20" width="130" height="130" rx="18"/>
    <rect x="20" y="20" width="130" height="130" rx="18"/>`,

  // shield with an eye-off slash — Focus / blocker
  focus: `    <path d="M0 -150 L130 -100 L130 24 C130 110 70 152 0 175 C-70 152 -130 110 -130 24 L-130 -100 Z"/>
    <circle cx="0" cy="-2" r="34"/>
    <line x1="-92" y1="-96" x2="96" y2="120"/>`,

  // calendar grid — Calendar
  calendar: `    <rect x="-140" y="-118" width="280" height="248" rx="24"/>
    <line x1="-140" y1="-52" x2="140" y2="-52"/>
    <line x1="-78" y1="-150" x2="-78" y2="-92"/>
    <line x1="78" y1="-150" x2="78" y2="-92"/>
    <circle cx="-66" cy="6" r="11" stroke-width="0" fill="currentColor"/>
    <circle cx="0" cy="6" r="11" stroke-width="0" fill="currentColor"/>
    <circle cx="66" cy="6" r="11" stroke-width="0" fill="currentColor"/>
    <circle cx="-66" cy="72" r="11" stroke-width="0" fill="currentColor"/>
    <circle cx="0" cy="72" r="11" stroke-width="0" fill="currentColor"/>`,

  // headphones — Facewear
  headphones: `    <path d="M-140 30 V-10 A140 140 0 0 1 140 -10 V30"/>
    <rect x="-160" y="26" width="58" height="110" rx="26" fill="currentColor" stroke-width="0"/>
    <rect x="102" y="26" width="58" height="110" rx="26" fill="currentColor" stroke-width="0"/>
    <rect x="-160" y="26" width="58" height="110" rx="26"/>
    <rect x="102" y="26" width="58" height="110" rx="26"/>`,

  // glasses — Smartglasses
  glasses: `    <circle cx="-86" cy="20" r="68"/>
    <circle cx="86" cy="20" r="68"/>
    <path d="M-18 20 Q0 -2 18 20"/>
    <line x1="-154" y1="-12" x2="-180" y2="-44"/>
    <line x1="154" y1="-12" x2="180" y2="-44"/>`,

  // line chart rising with axis — Finances
  finances: `    <polyline points="-150,-150 -150,150 150,150"/>
    <polyline points="-118,86 -50,-2 6,52 76,-62 132,-104" fill="none"/>
    <circle cx="-50" cy="-2" r="13" stroke-width="0" fill="currentColor"/>
    <circle cx="76" cy="-62" r="13" stroke-width="0" fill="currentColor"/>
    <circle cx="132" cy="-104" r="13" stroke-width="0" fill="currentColor"/>`,

  // target with center dot and a flag — Goals
  goals: `    <circle cx="0" cy="0" r="150"/>
    <circle cx="0" cy="0" r="92"/>
    <circle cx="0" cy="0" r="34"/>
    <circle cx="0" cy="0" r="9" stroke-width="0" fill="currentColor"/>`,

  // heart with a pulse line through it — Health
  health: `    <path d="M0 150 C-180 18 -120 -120 0 -52 C120 -120 180 18 0 150 Z"/>
    <polyline points="-150,-10 -64,-10 -28,-58 14,52 48,-10 150,-10" fill="none"/>`,

  // inbox tray — Inbox
  inbox: `    <path d="M-150 -40 L-110 -130 H110 L150 -40 V120 A20 20 0 0 1 130 140 H-130 A20 20 0 0 1 -150 120 Z"/>
    <path d="M-150 -40 H-44 L-10 24 H10 L44 -40 H150"/>`,

  // chat bubble with lines — Messages
  messages: `    <path d="M-150 -120 H150 A24 24 0 0 1 174 -96 V60 A24 24 0 0 1 150 84 H-30 L-100 150 V84 H-150 A24 24 0 0 1 -174 60 V-96 A24 24 0 0 1 -150 -120 Z"/>
    <line x1="-100" y1="-44" x2="100" y2="-44"/>
    <line x1="-100" y1="16" x2="40" y2="16"/>`,

  // trending up arrow over people dots — Social Alpha
  socialAlpha: `    <polyline points="-150,80 -54,-22 6,38 150,-110" fill="none"/>
    <polyline points="92,-110 150,-110 150,-52" fill="none"/>
    <circle cx="-110" cy="128" r="26"/>
    <circle cx="0" cy="128" r="26"/>
    <circle cx="110" cy="128" r="26"/>`,

  // checklist square — Todos
  todos: `    <rect x="-150" y="-150" width="300" height="300" rx="36"/>
    <polyline points="-92,-6 -36,52 92,-78" fill="none"/>`,

  // network graph nodes — Vector Browser / Relationships
  vectorBrowser: `    <line x1="-110" y1="-96" x2="0" y2="0"/>
    <line x1="120" y1="-110" x2="0" y2="0"/>
    <line x1="-130" y1="86" x2="0" y2="0"/>
    <line x1="110" y1="104" x2="0" y2="0"/>
    <circle cx="0" cy="0" r="30" fill="currentColor" stroke-width="0"/>
    <circle cx="0" cy="0" r="30"/>
    <circle cx="-110" cy="-96" r="22"/>
    <circle cx="120" cy="-110" r="22"/>
    <circle cx="-130" cy="86" r="22"/>
    <circle cx="110" cy="104" r="22"/>`,
} as const;

export type ViewHeroIconKind = keyof typeof VIEW_HERO_ICONS;

/**
 * Curated, non-blue accent hues spread across warm/jewel tones. Deliberately
 * excludes the pure-blue band (~200–250) so a generated hero never reads as a
 * flat blue panel on the app surface.
 */
const VIEW_HERO_HUES = [
  12, 25, 38, 52, 96, 130, 150, 168, 190, 270, 286, 300, 332, 348,
] as const;

function hashString(value: string): number {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0;
  }
  return Math.abs(hash);
}

/** Deterministically pick a non-blue accent hue for an arbitrary view key. */
export function hueForViewKey(key: string): number {
  const trimmed = key.trim() || "view";
  return VIEW_HERO_HUES[hashString(trimmed) % VIEW_HERO_HUES.length];
}

/**
 * Keyword → icon-glyph rules, checked in order. The first rule whose keyword is
 * present in the view's id/label/tags/Lucide-icon name wins; otherwise the
 * generic overlapping-panels glyph is used.
 */
const ICON_KEYWORD_RULES: ReadonlyArray<[ViewHeroIconKind, readonly string[]]> =
  [
    ["calendar", ["calendar", "schedule", "event", "agenda"]],
    ["health", ["health", "fitness", "heart", "wellness", "medical"]],
    [
      "finances",
      [
        "finance",
        "wallet",
        "money",
        "payment",
        "budget",
        "bank",
        "trade",
        "invest",
      ],
    ],
    ["goals", ["goal", "target", "objective", "habit", "routine"]],
    ["inbox", ["inbox", "mail", "email"]],
    ["messages", ["message", "chat", "dm", "conversation", "sms"]],
    [
      "socialAlpha",
      ["social", "leaderboard", "trust", "alpha", "feed", "follow"],
    ],
    ["todos", ["todo", "task", "checklist", "todos"]],
    [
      "vectorBrowser",
      [
        "vector",
        "graph",
        "relationship",
        "network",
        "entity",
        "embedding",
        "people",
        "contact",
      ],
    ],
    [
      "focus",
      ["focus", "block", "shield", "guard", "screen-time", "screentime"],
    ],
    [
      "headphones",
      ["headphone", "audio", "facewear", "wear", "sound", "voice"],
    ],
    ["glasses", ["glass", "smartglass", "xr", "spatial", "vision"]],
    ["modelTester", ["model", "test", "chip", "cpu", "bench", "eval", "train"]],
  ];

export interface ViewHeroSource {
  id?: string;
  label: string;
  /** Lucide icon name declared by the view, used as a keyword hint. */
  icon?: string;
  tags?: readonly string[];
}

/** Pick the best-matching icon glyph for a view, defaulting to the grid. */
export function pickViewHeroIcon(source: ViewHeroSource): ViewHeroIconKind {
  const haystack = [
    source.id ?? "",
    source.label,
    source.icon ?? "",
    ...(source.tags ?? []),
  ]
    .join(" ")
    .toLowerCase();
  for (const [icon, keywords] of ICON_KEYWORD_RULES) {
    if (keywords.some((keyword) => haystack.includes(keyword))) return icon;
  }
  return "views";
}

/** Lowercase slug safe to embed in SVG element ids. */
function slugifyViewId(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "view";
}

/**
 * High-level entry point: render a branded hero SVG for a view, choosing the
 * accent hue and icon glyph automatically from the view's metadata. Used by the
 * agent's hero fallback and by view scaffolding/icon-regeneration so a generated
 * hero looks the same everywhere.
 */
export function generateViewHeroSvgFor(source: ViewHeroSource): string {
  const slug = slugifyViewId(source.id ?? source.label);
  return renderViewHeroSvg({
    id: slug,
    hue: hueForViewKey(source.id ?? source.label),
    iconSvg: VIEW_HERO_ICONS[pickViewHeroIcon(source)],
    label: source.label,
  });
}
