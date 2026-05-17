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

export function passesFilter(row: FeedRowSummary, filter: FeedFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "tasks":
      return row.kind === "task";
    case "workflows":
      return row.kind === "workflow";
    case "active":
      return row.active;
    case "inactive":
      return !row.active;
    default:
      return true;
  }
}
