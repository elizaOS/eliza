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
    // Collapsed plugins: every modality (gui/tui/xr) is drawn from one single
    // view declaration that shares ONE route, so the tui case uses the same
    // path as its gui case, not a separate `/<id>/tui` route.
    ["companion", "gui", "/companion"],
    ["companion", "tui", "/companion"],
    ["contacts", "gui", "/contacts"],
    ["contacts", "tui", "/contacts"],
    ["hyperliquid", "gui", "/hyperliquid"],
    ["hyperliquid", "tui", "/hyperliquid"],
    ["focus", "gui", "/focus"],
    ["focus", "tui", "/focus"],
    ["calendar", "gui", "/calendar"],
    ["calendar", "tui", "/calendar"],
    ["documents", "gui", "/documents"],
    ["documents", "tui", "/documents"],
    ["finances", "gui", "/finances"],
    ["finances", "tui", "/finances"],
    ["goals", "gui", "/goals"],
    ["goals", "tui", "/goals"],
    ["health", "gui", "/health"],
    ["health", "tui", "/health"],
    ["inbox", "gui", "/inbox"],
    ["inbox", "tui", "/inbox"],
    ["relationships", "gui", "/relationships"],
    ["relationships", "tui", "/relationships"],
    ["todos", "gui", "/todos"],
    ["todos", "tui", "/todos"],
    ["messages", "gui", "/messages"],
    ["messages", "tui", "/messages"],
    ["model-tester", "gui", "/model-tester"],
    ["model-tester", "tui", "/model-tester"],
    ["phone", "gui", "/phone"],
    ["phone", "tui", "/phone"],
    ["polymarket", "gui", "/polymarket"],
    ["polymarket", "tui", "/polymarket"],
    ["shopify", "gui", "/shopify"],
    ["shopify", "tui", "/shopify"],
    ["steward", "gui", "/steward"],
    ["steward", "tui", "/steward"],
    ["vincent", "gui", "/vincent"],
    ["vincent", "tui", "/vincent"],
    ["waifu-imagegen", "gui", "/waifu-imagegen"],
    ["waifu-imagegen", "tui", "/waifu-imagegen"],
    ["waifu-swap", "gui", "/waifu-swap"],
    ["waifu-swap", "tui", "/waifu-swap"],
    ["wallet", "gui", "/wallet"],
    ["wallet", "tui", "/wallet"],
    ["vector-browser", "gui", "/vector-browser"],
    ["vector-browser", "tui", "/vector-browser"],
    ["feed", "gui", "/feed"],
    ["feed", "tui", "/feed"],
    ["views-manager", "gui", "/views"],
    ["views-manager", "tui", "/views"],
    ["clawville", "gui", "/clawville"],
    ["clawville", "tui", "/clawville"],
    ["screenshare", "gui", "/screenshare"],
    ["screenshare", "tui", "/screenshare"],
    ["social-alpha", "gui", "/social-alpha"],
    ["social-alpha", "tui", "/social-alpha"],
    ["task-coordinator", "gui", "/task-coordinator"],
    ["task-coordinator", "tui", "/task-coordinator"],
    ["orchestrator", "gui", "/orchestrator"],
    ["orchestrator", "tui", "/orchestrator"],
    ["trajectory-logger", "gui", "/trajectory-logger"],
    ["trajectory-logger", "tui", "/trajectory-logger"],
    ["training", "gui", "/apps/fine-tuning"],
    ["training", "tui", "/apps/fine-tuning"],
    ["facewear", "gui", "/apps/facewear"],
    ["facewear", "tui", "/apps/facewear"],
    ["smartglasses", "gui", "/apps/smartglasses"],
    ["smartglasses", "tui", "/apps/smartglasses"],
  ] satisfies ViewCaseTuple[]
).map(([id, viewType, viewPath, options]) => ({
  id,
  viewType,
  path: viewPath,
  shellPill: options?.shellPill === "suppressed" ? "suppressed" : "expected",
}));
