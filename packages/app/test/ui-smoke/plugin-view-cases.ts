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
    // Collapsed plugins: gui + tui share the SAME route (`/<id>`); the tui
    // modality is drawn from the same single declaration, not a `/<id>/tui`
    // route. Plugins that still declare a standalone tui route (training) keep
    // their `/<id>/tui` path below.
    ["companion", "gui", "/companion"],
    ["companion", "tui", "/companion"],
    ["contacts", "gui", "/contacts"],
    ["contacts", "tui", "/contacts"],
    ["hyperliquid", "gui", "/hyperliquid"],
    ["hyperliquid", "tui", "/hyperliquid"],
    ["focus", "gui", "/focus"],
    ["calendar", "gui", "/calendar"],
    ["documents", "gui", "/documents"],
    ["finances", "gui", "/finances"],
    ["goals", "gui", "/goals"],
    ["health", "gui", "/health"],
    ["inbox", "gui", "/inbox"],
    ["relationships", "gui", "/relationships"],
    ["todos", "gui", "/todos"],
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
    ["waifu-swap", "gui", "/waifu-swap"],
    ["wallet", "gui", "/wallet"],
    ["wallet", "tui", "/wallet"],
    ["vector-browser", "gui", "/vector-browser"],
    ["feed", "gui", "/feed"],
    ["feed", "tui", "/feed"],
    ["views-manager", "gui", "/views"],
    ["views-manager", "tui", "/views"],
    ["clawville", "gui", "/clawville"],
    ["clawville", "tui", "/clawville"],
    ["defense-of-the-agents", "gui", "/defense-of-the-agents"],
    ["defense-of-the-agents", "tui", "/defense-of-the-agents"],
    ["screenshare", "gui", "/screenshare"],
    ["screenshare", "tui", "/screenshare"],
    ["social-alpha", "gui", "/social-alpha"],
    ["task-coordinator", "gui", "/task-coordinator"],
    ["task-coordinator", "tui", "/task-coordinator"],
    ["orchestrator", "gui", "/orchestrator"],
    ["orchestrator", "tui", "/orchestrator"],
    ["trajectory-logger", "gui", "/trajectory-logger"],
    ["trajectory-logger", "tui", "/trajectory-logger"],
    ["training", "gui", "/apps/fine-tuning"],
    ["training", "tui", "/training/tui"],
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
