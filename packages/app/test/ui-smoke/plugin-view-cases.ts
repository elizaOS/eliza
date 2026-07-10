/**
 * Plugin-view case fixtures used by UI-smoke specs to exercise registered
 * plugin surfaces.
 */
export type ViewCase = {
  id: string;
  viewType: "gui";
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
    // Shipped plugin views are GUI-only. The shared viewType contract still
    // accepts future modalities, but this smoke matrix tracks what the app can
    // render today.
    ["birdclaw", "gui", "/birdclaw"],
    ["cloud", "gui", "/cloud"],
    ["contacts", "gui", "/contacts"],
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
    ["cockpit", "gui", "/cockpit"],
    ["trajectory-logger", "gui", "/trajectory-logger"],
    ["training", "gui", "/apps/fine-tuning"],
  ] satisfies ViewCaseTuple[]
).map(([id, viewType, viewPath, options]) => ({
  id,
  viewType,
  path: viewPath,
  shellPill: options?.shellPill === "suppressed" ? "suppressed" : "expected",
}));
