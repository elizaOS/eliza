/**
 * automation-feed-filter — pure filter logic for the AutomationsFeed.
 * Lives outside the React component so it can be tested in node-only
 * vitest without resolving the rest of the UI bundle.
 */

export type FeedFilter =
  | "all"
  | "prompts"
  | "workflows"
  | "active"
  | "inactive";

// `kind` is the internal row discriminant: a "task" row is a workbench prompt
// automation (glossary "prompt automation"); a "workflow" row is a node-graph
// workflow. The user-facing filter for prompt automations is "prompts".
export interface FeedRowSummary {
  // A workbench/simple automation surfaces as kind "task" in the read-model;
  // in glossary terms it is a "prompt" automation, which the "prompts" filter
  // selects.
  kind: "task" | "workflow";
  active: boolean;
}

export function passesFilter(row: FeedRowSummary, filter: FeedFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "prompts":
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
