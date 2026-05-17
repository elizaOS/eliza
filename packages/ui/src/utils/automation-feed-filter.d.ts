/**
 * automation-feed-filter — pure filter logic for the AutomationsFeed.
 * Lives outside the React component so it can be tested in node-only
 * vitest without resolving the rest of the UI bundle.
 */
export type FeedFilter = "all" | "tasks" | "workflows" | "active" | "inactive";
export interface FeedRowSummary {
  kind: "task" | "workflow";
  active: boolean;
}
export declare function passesFilter(
  row: FeedRowSummary,
  filter: FeedFilter,
): boolean;
//# sourceMappingURL=automation-feed-filter.d.ts.map
