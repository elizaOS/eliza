/**
 * AutomationsFeed — focused, single-screen list of every automation
 * (tasks AND workflows) with the same row format. Click a row to open
 * the matching editor (TaskEditor or WorkflowEditor).
 *
 * This component is intentionally separate from the existing
 * `AutomationsView` — that surface is the full dashboard with sidebar
 * chat, palette, node catalog, etc. This is the "obvious nobody thinks
 * about it" feed for users who just want to see what's running.
 *
 * Backend dependencies:
 *   GET  /api/automations          (existing)
 *   GET  /api/workbench/tasks      (existing, via WorkbenchTask types)
 *   POST /api/workbench/tasks      (existing)
 *   POST /api/workflow/workflows   (existing)
 *   POST /api/workflow/workflows/generate  (existing)
 *   POST /api/workflow/workflows/:id/activate (existing)
 *
 * No backend changes are required.
 */
export type { FeedFilter } from "../../utils/automation-feed-filter";
export { passesFilter } from "../../utils/automation-feed-filter";
export interface AutomationsFeedProps {
  /**
   * Cred types the user has already connected. Used to compute the
   * per-row "Connect <Provider> →" missing-creds banner. Keep this
   * driven from the host (App.tsx pulls connector accounts) so the feed
   * stays a pure display component.
   */
  connectedCredTypes?: ReadonlySet<string>;
  /**
   * Render the in-shell chat sidebar. Default: false (host opts in).
   * Hidden on narrow viewports via the layout regardless.
   */
  showChatPane?: boolean;
}
export declare function AutomationsFeed({
  connectedCredTypes,
  showChatPane,
}?: AutomationsFeedProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=AutomationsFeed.d.ts.map
