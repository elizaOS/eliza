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
    // Non-system views must be manager-visible to appear in the springboard
    // grid (system ids like settings/files/tasks are exempt from that gate).
    visibleInManager,
    viewKind: "release",
  };
}

// A roster big enough to fill TWO springboard pages (page size 20). The four
// dock favorites (settings/activity/files/tasks) pin to the dock; the rest pack
// into the page grid, so the springboard has 2 pages — which is what makes the
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
      // chat/views are filtered out of the springboard (self-links) — kept so
      // the e2e can assert their ABSENCE.
      builtinView("chat", "Chat", "/chat"),
      builtinView("views", "Views", "/views"),
      // Dock favorites — DISTINCT per-view icons (#5 regression check).
      builtinView("settings", "Settings", "/settings", "Settings"),
      builtinView("activity", "Activity", "/activity", "Activity", true),
      builtinView("files", "Files", "/apps/files", "FolderClosed"),
      builtinView("tasks", "Tasks", "/apps/tasks", "ListTodo"),
      ...gridViews,
    ],
    loading: false,
    error: null,
    refresh: () => {},
  };
}
