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

// A roster big enough to fill TWO launcher pages (page size 20). The four
// dock favorites (settings/activity/files/tasks) pin to the dock; the rest pack
// into the page grid, so the launcher has 2 pages — which is what makes the
// doubled-dots regression observable (a single page never rendered inner dots),
// and gives the icon-distinctness check real, varied glyphs to compare.
const GRID_ICONS = [
  "Inbox", "Mail", "CalendarDays", "Heart", "Target", "Network",
  "Database", "Terminal", "Wallet", "ShoppingBag", "Rss", "Bot",
  "BrainCircuit", "Monitor", "Radio", "ScrollText", "Globe", "Plug",
  "Sparkles", "Phone", "Users", "ImageIcon",
];

export function useRoutableViews() {
  const gridViews = GRID_ICONS.map((icon, i) =>
    builtinView(`app${i}`, `App ${i}`, `/apps/app${i}`, icon, true),
  );
  return {
    views: [
      // chat/views are filtered out of the launcher (self-links) — kept so
      // the e2e can assert their ABSENCE.
      builtinView("chat", "Chat", "/chat"),
      builtinView("views", "Views", "/views"),
      // Dock favorites — real branded hero IMAGES (the agent serves these on
      // device); rendered as <img> tiles, proving the launcher shows real
      // image icons, not the glyph fallback (task: real image icons).
      builtinView("settings", "Settings", "/settings", "Settings", false, heroDataUri(28)),
      builtinView("activity", "Activity", "/activity", "Activity", true, heroDataUri(150)),
      builtinView("files", "Files", "/apps/files", "FolderClosed", false, heroDataUri(210)),
      builtinView("tasks", "Tasks", "/apps/tasks", "ListTodo", false, heroDataUri(280)),
      ...gridViews,
    ],
    loading: false,
    error: null,
    refresh: () => {},
  };
}
