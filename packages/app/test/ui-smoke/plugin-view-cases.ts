/**
 * Plugin-view case fixtures used by UI-smoke specs to exercise registered
 * plugin surfaces.
 */
export type ViewCase = {
  id: string;
  viewType: "gui";
  path: string;
  shellPill: "expected" | "suppressed";
  /**
   * Minimum normalized `<main>` innerText length that counts as "loaded".
   * Views whose designed keyless empty state is a single short word (the
   * focus view renders just "Idle") override the
   * default so the load heuristic cannot false-negative on them.
   */
  minVisibleTextLength: number;
};

type ViewCaseTuple = readonly [
  id: string,
  viewType: ViewCase["viewType"],
  path: string,
  options?: {
    shellPill?: ViewCase["shellPill"];
    minVisibleTextLength?: number;
  },
];

export const VIEW_CASES: ViewCase[] = (
  [
    // Shipped plugin views are GUI-only. The shared viewType contract still
    // accepts future modalities, but this smoke matrix tracks what the app can
    // render today.
    ["cloud", "gui", "/cloud"],
    ["contacts", "gui", "/contacts"],
    ["focus", "gui", "/focus", { minVisibleTextLength: 4 }],
    ["calendar", "gui", "/calendar"],
    ["computer-use-sessions", "gui", "/computer-use-sessions"],
    ["documents", "gui", "/documents"],
    ["finances", "gui", "/finances"],
    ["goals", "gui", "/goals"],
    ["lifeops-live-test", "gui", "/lifeops-live-test"],
    ["health", "gui", "/health"],
    ["inbox", "gui", "/inbox"],
    ["relationships", "gui", "/relationships"],
    ["todos", "gui", "/todos"],
    ["messages", "gui", "/messages"],
    ["phone", "gui", "/phone"],
    ["wallet", "gui", "/wallet"],
    ["views-manager", "gui", "/views"],
    ["notes", "gui", "/notes"],
    ["task-coordinator", "gui", "/task-coordinator"],
    ["orchestrator", "gui", "/orchestrator"],
    ["cockpit", "gui", "/cockpit"],
    ["trajectory-logger", "gui", "/trajectory-logger"],
  ] satisfies ViewCaseTuple[]
).map(([id, viewType, viewPath, options]) => ({
  id,
  viewType,
  path: viewPath,
  shellPill: options?.shellPill === "suppressed" ? "suppressed" : "expected",
  minVisibleTextLength: options?.minVisibleTextLength ?? 21,
}));
