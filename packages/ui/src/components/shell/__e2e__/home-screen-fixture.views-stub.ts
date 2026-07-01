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

/** A distinct branded-tile data-URI hero (gradient square), keyed by hue. */
function heroDataUri(hue: number): string {
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'>` +
    `<defs><linearGradient id='g' x1='0' y1='0' x2='1' y2='1'>` +
    `<stop offset='0' stop-color='hsl(${hue} 72% 56%)'/>` +
    `<stop offset='1' stop-color='hsl(${(hue + 38) % 360} 70% 42%)'/>` +
    `</linearGradient></defs>` +
    `<rect width='64' height='64' fill='url(#g)'/>` +
    `<circle cx='44' cy='20' r='22' fill='#ffffff' opacity='0.18'/>` +
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
      // Shell self-links + removed apps. Chat remains a normal launcher tile;
      // the rest stay absent from the launcher.
      builtinView("chat", "Chat", "/chat"),
      builtinView("views", "Views", "/views"),
      builtinView("shopify", "Shopify", "/shopify", "ShoppingBag", true),
      builtinView("hyperliquid", "Hyperliquid", "/hyperliquid", "TrendingUp", true),
      // Page 1 — everyday apps (curated order is enforced by launcher-curation).
      builtinView("wallet", "Wallet", "/wallet", "Wallet", true, heroDataUri(28)),
      // Duplicate wallet registration — must collapse to the single Wallet tile.
      builtinView("inventory", "Wallet", "/wallet", "Wallet"),
      builtinView("automations", "Automations", "/automations", "Clock3", true, heroDataUri(64)),
      // Duplicate automations registration — folds into the one Automations tile.
      builtinView("triggers", "Automations", "/automations", "Clock3"),
      builtinView("browser", "Browser", "/browser", "Globe", true, heroDataUri(150)),
      builtinView("character", "Character", "/character", "Bot", true, heroDataUri(200)),
      builtinView("documents", "Knowledge", "/character/documents", "FileText", true, heroDataUri(240)),
      builtinView("transcripts", "Transcripts", "/apps/transcripts", "AudioLines", true),
      builtinView("relationships", "Relationships", "/apps/relationships", "Network", true),
      builtinView("memories", "Memories", "/apps/memories", "Brain", true),
      builtinView("feed", "Feed", "/feed", "Rss", true),
      builtinView("stream", "Stream", "/stream", "Radio", true),
      builtinView("settings", "Settings", "/settings", "Settings", false, heroDataUri(28)),
      // Page 2 — developer tools.
      builtinView("trajectories", "Trajectories", "/apps/trajectories", "Activity", true, heroDataUri(300)),
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
