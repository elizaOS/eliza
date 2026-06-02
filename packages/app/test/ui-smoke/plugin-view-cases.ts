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
    ["companion", "gui", "/companion"],
    ["companion", "tui", "/companion/tui"],
    ["contacts", "gui", "/contacts"],
    ["contacts", "tui", "/contacts/tui"],
    ["hyperliquid", "gui", "/hyperliquid"],
    ["hyperliquid", "tui", "/hyperliquid/tui"],
    ["lifeops", "gui", "/lifeops"],
    ["lifeops", "tui", "/lifeops/tui"],
    ["messages", "gui", "/messages"],
    ["messages", "tui", "/messages/tui"],
    ["model-tester", "gui", "/model-tester"],
    ["model-tester", "tui", "/model-tester/tui"],
    ["phone", "gui", "/phone"],
    ["phone", "tui", "/phone/tui"],
    ["polymarket", "gui", "/polymarket"],
    ["polymarket", "tui", "/polymarket/tui"],
    ["shopify", "gui", "/shopify"],
    ["shopify", "tui", "/shopify/tui"],
    ["steward", "gui", "/steward"],
    ["steward", "tui", "/steward/tui"],
    ["vincent", "gui", "/vincent"],
    ["vincent", "tui", "/vincent/tui"],
    ["wallet", "gui", "/wallet"],
    ["wallet", "tui", "/wallet/tui"],
    ["2004scape", "gui", "/2004scape"],
    ["2004scape", "tui", "/2004scape/tui"],
    ["feed", "gui", "/feed"],
    ["feed", "tui", "/feed/tui"],
    ["views-manager", "gui", "/views"],
    ["views-manager", "tui", "/views/tui"],
    ["clawville", "gui", "/clawville"],
    ["clawville", "tui", "/clawville/tui"],
    ["defense-of-the-agents", "gui", "/defense-of-the-agents"],
    ["defense-of-the-agents", "tui", "/defense-of-the-agents/tui"],
    ["hyperscape", "gui", "/hyperscape"],
    ["hyperscape", "tui", "/hyperscape/tui"],
    ["scape", "gui", "/scape"],
    ["scape", "tui", "/scape/tui"],
    ["screenshare", "gui", "/screenshare"],
    ["screenshare", "tui", "/screenshare/tui"],
    ["task-coordinator", "gui", "/task-coordinator"],
    ["task-coordinator", "tui", "/task-coordinator/tui"],
    ["odysseus", "gui", "/odysseus", { shellPill: "suppressed" }],
    ["odysseus", "tui", "/odysseus/tui"],
    ["orchestrator", "gui", "/orchestrator", { shellPill: "suppressed" }],
    ["orchestrator", "tui", "/orchestrator/tui"],
    ["trajectory-logger", "gui", "/trajectory-logger"],
    ["trajectory-logger", "tui", "/trajectory-logger/tui"],
    ["training", "gui", "/training"],
    ["training", "tui", "/training/tui"],
    ["facewear", "gui", "/apps/hearwear"],
    ["facewear", "tui", "/apps/hearwear/tui"],
    ["smartglasses", "gui", "/apps/smartglasses"],
    ["smartglasses", "tui", "/apps/smartglasses/tui"],
  ] satisfies ViewCaseTuple[]
).map(([id, viewType, viewPath, options]) => ({
  id,
  viewType,
  path: viewPath,
  shellPill: options?.shellPill === "suppressed" ? "suppressed" : "expected",
}));
