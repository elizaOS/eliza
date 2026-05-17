interface BudgetPanelProps {
  jobId: string;
}
/**
 * Running-cost panel for a Vast.ai training job (M9).
 *
 * Renders the live `dph_total × uptime` snapshot plus the soft / hard
 * budget caps from `ELIZA_VAST_MAX_USD`. The hard cap is enforced by
 * the watcher (auto-teardown) — this panel only displays state, it
 * does not call any destructive endpoint.
 */
export declare function BudgetPanel({
  jobId,
}: BudgetPanelProps): import("react/jsx-runtime").JSX.Element;
//# sourceMappingURL=BudgetPanel.d.ts.map
