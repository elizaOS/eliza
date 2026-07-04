// Stub for useAvailableViews in the home-screen e2e: report the view paths the
// home tiles gate on as registered, so the gated tiles (orchestrator,
// workflows, inbox) render deterministically.
import type { ViewRegistryEntry } from "../../../hooks/useAvailableViews";

export function useAvailableViews() {
  return {
    views: [
      { id: "orchestrator", path: "/orchestrator" },
      { id: "automations", path: "/automations" },
      { id: "inbox", path: "/inbox" },
    ],
    loading: false,
  };
}

// The launcher's catalog-loader pulls the imperative fetch alongside the hook;
// the stub replaces the whole module, so it must export this too. No registry in
// the fixture — the deterministic tiles come from the builtin views below.
export async function fetchAvailableViews(): Promise<ViewRegistryEntry[]> {
  return [];
}

function builtinView(
  id: string,
  label: string,
  path: string,
  icon?: string,
  visibleInManager = false,
  heroImageUrl?: string,
): ViewRegistryEntry {
  return {
    id,
    label,
    path,
    icon,
    viewType: "gui",
    available: true,
    pluginName: "@elizaos/builtin",
    builtin: true,
    // Non-system views must be manager-visible to appear in the launcher
    // grid (system ids like settings/files/tasks are exempt from that gate).
    visibleInManager,
    viewKind: "release",
    // A real hero image (the agent serves a branded SVG at /api/views/:id/hero
    // on device). Provided as an inline data-URI here so the file:// e2e renders
    // the actual <img> tile path — proving the launcher shows real image
    // icons, not the glyph fallback.
    ...(heroImageUrl
      ? { hasHeroImage: true, heroImageUrl }
      : {}),
  };
}

// Simple white glyphs drawn into the synthetic hero tiles so they read as
// finished app icons in demo captures instead of blank gradient squares.
// Keyed by view id; every hero tile must have one.
const HERO_GLYPHS: Record<string, string> = {
  // Wallet — card body + clasp.
  wallet:
    `<g fill='none' stroke='#ffffff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'>` +
    `<rect x='16' y='22' width='32' height='22' rx='5'/><path d='M40 33h6'/></g>`,
  // Automations — clock face.
  automations:
    `<g fill='none' stroke='#ffffff' stroke-width='4' stroke-linecap='round'>` +
    `<circle cx='32' cy='33' r='14'/><path d='M32 25v8l6 4'/></g>`,
  // Browser — globe.
  browser:
    `<g fill='none' stroke='#ffffff' stroke-width='4' stroke-linecap='round'>` +
    `<circle cx='32' cy='33' r='14'/><path d='M18 33h28'/><ellipse cx='32' cy='33' rx='7' ry='14'/></g>`,
  // Character — head + shoulders.
  character:
    `<g fill='none' stroke='#ffffff' stroke-width='4' stroke-linecap='round'>` +
    `<circle cx='32' cy='26' r='7'/><path d='M20 46c2-7 6-10 12-10s10 3 12 10'/></g>`,
  // Knowledge — open book.
  documents:
    `<g fill='none' stroke='#ffffff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'>` +
    `<path d='M32 23c-4-3-9-3-13-1v21c4-2 9-2 13 1c4-3 9-3 13-1V22c-4-2-9-2-13 1'/><path d='M32 23v21'/></g>`,
  // Settings — gear (hub + spokes).
  settings:
    `<g fill='none' stroke='#ffffff' stroke-width='4' stroke-linecap='round'>` +
    `<circle cx='32' cy='33' r='7'/>` +
    `<path d='M32 17v6M32 43v6M16 33h6M42 33h6M21 22l4 4M39 40l4 4M43 22l-4 4M25 40l-4 4'/></g>`,
  // Trajectories — activity pulse.
  trajectories:
    `<path d='M14 33h9l5-12l7 24l5-12h10' fill='none' stroke='#ffffff' stroke-width='4' stroke-linecap='round' stroke-linejoin='round'/>`,
};

/**
 * A distinct branded-tile data-URI hero (gradient + white glyph), keyed by hue
 * and view id. Hues stay out of the blue range (no-blue brand rule).
 */
function heroDataUri(hue: number, glyphId: string): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue} 72% 56%)'/>` +
    `<stop offset='1' stop-color='hsl(${(hue + 38) % 360} 70% 42%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='64' height='64' fill='url(#g)'/>` +
    `<circle cx='44' cy='20' r='22' fill='#ffffff' opacity='0.18'/>` +
    (HERO_GLYPHS[glyphId] ?? "") +
    `</svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

// The curated launcher view set: page 1 is the everyday apps, page 2 is the
// developer tools (trajectories/database/runtime/logs/skills/plugins). A few
// carry real branded hero IMAGES so the tiles render <img> icons, proving the
// launcher shows real image icons (not the glyph fallback). Duplicate/removed
// registrations are included so the e2e proves curation drops + dedupes them.
export function useRoutableViews() {
  return {
    views: [
      // Shell surfaces + removed apps — kept so the e2e asserts their ABSENCE.
      builtinView("chat", "Chat", "/chat"),
      builtinView("views", "Views", "/views"),
      builtinView("shopify", "Shopify", "/shopify", "ShoppingBag", true),
      builtinView("hyperliquid", "Hyperliquid", "/hyperliquid", "TrendingUp", true),
      // Page 1 — everyday apps (curated order is enforced by launcher-curation).
      builtinView("wallet", "Wallet", "/wallet", "Wallet", true, heroDataUri(28, "wallet")),
      // Duplicate wallet registration — must collapse to the single Wallet tile.
      builtinView("inventory", "Wallet", "/wallet", "Wallet"),
      builtinView("automations", "Automations", "/automations", "Clock3", true, heroDataUri(64, "automations")),
      // Duplicate automations registration — folds into the one Automations tile.
      builtinView("triggers", "Automations", "/automations", "Clock3"),
      builtinView("browser", "Browser", "/browser", "Globe", true, heroDataUri(150, "browser")),
      // Hues 348/96 (raspberry/green): the old 200/240 heroes rendered BLUE
      // Character/Knowledge tiles, violating the no-blue brand rule.
      builtinView("character", "Character", "/character", "Bot", true, heroDataUri(348, "character")),
      builtinView("documents", "Knowledge", "/character/documents", "FileText", true, heroDataUri(96, "documents")),
      builtinView("transcripts", "Transcripts", "/apps/transcripts", "AudioLines", true),
      builtinView("relationships", "Relationships", "/apps/relationships", "Network", true),
      builtinView("memories", "Memories", "/apps/memories", "Brain", true),
      builtinView("feed", "Feed", "/feed", "Rss", true),
      builtinView("stream", "Stream", "/stream", "Radio", true),
      builtinView("settings", "Settings", "/settings", "Settings", false, heroDataUri(28, "settings")),
      // Page 2 — developer tools.
      builtinView("trajectories", "Trajectories", "/apps/trajectories", "Activity", true, heroDataUri(300, "trajectories")),
      builtinView("database", "Databases", "/apps/database", "Database", true),
      builtinView("runtime", "Runtime", "/apps/runtime", "Terminal", false),
      builtinView("logs", "Logs", "/apps/logs", "ScrollText", true),
      builtinView("skills", "Skills", "/apps/skills", "Sparkles", false),
      builtinView("plugins", "Plugins", "/apps/plugins", "Plug", true),
    ],
    loading: false,
    error: null,
    refresh: () => {},
  };
}

export async function fetchAvailableViews(): Promise<ViewRegistryEntry[]> {
  return useRoutableViews().views;
}
