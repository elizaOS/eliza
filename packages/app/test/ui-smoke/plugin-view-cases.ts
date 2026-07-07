/**
 * Plugin-view case fixtures used by UI-smoke specs to exercise registered
 * plugin surfaces.
 */
export type ViewCase = {
  id: string;
  viewType: "gui" | "tui";
  path: string;
  shellPill: "expected" | "suppressed";
};

type ViewCaseTuple = readonly [
  id: string,
  viewType: ViewCase["viewType"],
  path: string,
  options?: {
    shellPill: ViewCase["shellPill"];
  },
];

export const VIEW_CASES: ViewCase[] = (
  [
    // Shipped plugin views are GUI-only (#15269). The ViewCase type keeps
    // "tui" as a valid value so the reintroduction path stays typed, but no
    // shipped case declares it.
    ["birdclaw", "gui", "/birdclaw"],
    ["contacts", "gui", "/contacts"],
    ["cloud", "gui", "/cloud"],
    ["hyperliquid", "gui", "/hyperliquid"],
    ["focus", "gui", "/focus"],
    ["calendar", "gui", "/calendar"],
    ["documents", "gui", "/documents"],
    ["finances", "gui", "/finances"],
    ["goals", "gui", "/goals"],
    ["lifeops-live-test", "gui", "/lifeops-live-test"],
    ["health", "gui", "/health"],
    ["inbox", "gui", "/inbox"],
    ["relationships", "gui", "/relationships"],
    ["todos", "gui", "/todos"],
    ["messages", "gui", "/messages"],
    ["model-tester", "gui", "/model-tester"],
    ["phone", "gui", "/phone"],
    ["polymarket", "gui", "/polymarket"],
    ["wallet", "gui", "/wallet"],
    ["vector-browser", "gui", "/vector-browser"],
    ["feed", "gui", "/feed"],
    ["views-manager", "gui", "/views"],
    ["screenshare", "gui", "/screenshare"],
    ["task-coordinator", "gui", "/task-coordinator"],
    ["orchestrator", "gui", "/orchestrator"],
    // The coding cockpit is a developer-only, GUI-only plugin view.
    ["cockpit", "gui", "/cockpit"],
    ["trajectory-logger", "gui", "/trajectory-logger"],
    ["training", "gui", "/apps/fine-tuning"],
    // Facewear + smartglasses GUI config lives under Settings -> Wearables;
    // their former TUI-only surfaces were removed with the shipped TUI
    // inventory (#15269).
  ] satisfies ViewCaseTuple[]
).map(([id, viewType, viewPath, options]) => ({
  id,
  viewType,
  path: viewPath,
  shellPill: options?.shellPill === "suppressed" ? "suppressed" : "expected",
}));
