/**
 * Renders the authenticated, content-free context inspector for the active
 * conversation. It consumes only the redacted inspector DTO and never fetches
 * raw trajectories, source bodies, paths, or provider metadata.
 */

import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  Database,
  FileText,
  Gauge,
  Loader2,
  RefreshCw,
  ScanSearch,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type ContextInspectorEntry,
  type ContextInspectorResponse,
  client,
} from "../api";
import { useAppSelector } from "../state";
import { PagePanel } from "./composites/page-panel";
import { Button } from "./ui/button";
import { ShellViewAgentSurface } from "./views/ShellViewAgentSurface";

const PAGE_SIZE = 20;

function rangeLabel(entry: ContextInspectorEntry): string {
  const total = entry.range.total === undefined ? "?" : entry.range.total;
  return `${entry.range.unit} ${entry.range.start}–${entry.range.end} of ${total}`;
}

function stateTone(entry: ContextInspectorEntry): string {
  if (
    entry.completeness === "unavailable" ||
    entry.completeness === "partial-source-loss" ||
    entry.retentionState === "expired" ||
    entry.retentionState === "unavailable"
  ) {
    return "border-destructive/35 bg-destructive/5";
  }
  if (entry.completeness === "partial-recoverable") {
    return "border-accent/35 bg-accent/5";
  }
  return "border-border bg-surface/60";
}

function EntryCard({ entry }: { entry: ContextInspectorEntry }) {
  return (
    <article
      className={`rounded-xl border p-4 ${stateTone(entry)}`}
      data-testid="context-inspector-entry"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <FileText className="h-4 w-4 text-accent" aria-hidden />
            <span className="text-sm font-semibold capitalize text-txt">
              {entry.kind.replace("-", " ")}
            </span>
          </div>
          <code
            className="mt-2 block break-all text-xs text-muted"
            data-testid="context-inspector-reference"
          >
            {entry.reference}
          </code>
        </div>
        <span className="rounded-full border border-border px-2.5 py-1 text-xs text-muted">
          {entry.completeness}
        </span>
      </div>
      <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">Range</dt>
          <dd className="mt-1 text-txt">{rangeLabel(entry)}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">
            Retention
          </dt>
          <dd className="mt-1 text-txt">{entry.retentionState}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted">
            Omission reason
          </dt>
          <dd className="mt-1 text-txt">{entry.omissionReason ?? "none"}</dd>
        </div>
      </dl>
    </article>
  );
}

function BudgetSummary({ data }: { data: ContextInspectorResponse }) {
  const summary = useMemo(
    () =>
      data.tokenBudgets.reduce(
        (acc, budget) => ({
          used: acc.used + budget.usedTokens,
          limit: acc.limit + budget.limitTokens,
          reserved: acc.reserved + budget.reservedTokens,
          rejected: acc.rejected + (budget.state === "rejected" ? 1 : 0),
        }),
        { used: 0, limit: 0, reserved: 0, rejected: 0 },
      ),
    [data.tokenBudgets],
  );
  return (
    <div
      className="grid gap-3 rounded-xl border border-border bg-surface/60 p-4 sm:grid-cols-4"
      data-testid="context-inspector-budget"
    >
      <div className="flex items-center gap-2 sm:col-span-4">
        <Gauge className="h-4 w-4 text-accent" aria-hidden />
        <h2 className="text-sm font-semibold text-txt">
          Model request budgets
        </h2>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted">Used</div>
        <div className="mt-1 text-lg font-semibold text-txt">
          {summary.used}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted">Limit</div>
        <div className="mt-1 text-lg font-semibold text-txt">
          {summary.limit}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted">
          Reserved
        </div>
        <div className="mt-1 text-lg font-semibold text-txt">
          {summary.reserved}
        </div>
      </div>
      <div>
        <div className="text-xs uppercase tracking-wide text-muted">
          Requests
        </div>
        <div className="mt-1 text-lg font-semibold text-txt">
          {data.tokenBudgets.length}
          {summary.rejected > 0 ? ` (${summary.rejected} rejected)` : ""}
        </div>
      </div>
    </div>
  );
}

export default function ContextInspectorView() {
  const activeConversationId = useAppSelector(
    (state) => state.activeConversationId,
  );
  const [pagination, setPagination] = useState({
    conversationId: activeConversationId,
    offset: 0,
  });
  const offset =
    pagination.conversationId === activeConversationId ? pagination.offset : 0;
  const [data, setData] = useState<ContextInspectorResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!activeConversationId) {
      setData(null);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await client.getContextInspector(activeConversationId, {
        offset,
        limit: PAGE_SIZE,
      });
      setData(response);
    } catch (cause) {
      setData(null);
      setError(
        cause instanceof Error
          ? cause.message
          : "Context inspector is unavailable",
      );
    } finally {
      setLoading(false);
    }
  }, [activeConversationId, offset]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <ShellViewAgentSurface viewId="context-inspector">
      <PagePanel className="h-full" data-testid="context-inspector-view">
        <PagePanel.Header
          media={<ScanSearch className="h-5 w-5 text-accent" aria-hidden />}
          heading="Context inspector"
          description="Redacted references, exact included ranges, completeness, retention, and model budget use. Source content never appears here."
          actions={
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void load()}
              disabled={loading || !activeConversationId}
              data-testid="context-inspector-refresh"
            >
              <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
              Refresh
            </Button>
          }
        />
        <PagePanel.ContentArea className="space-y-4 p-4 sm:p-6">
          {!activeConversationId ? (
            <PagePanel.Empty
              icon={<Database className="h-5 w-5" aria-hidden />}
              title="No active conversation"
              description="Open a conversation to inspect its redacted context state."
            />
          ) : loading && !data ? (
            <div
              className="flex min-h-48 items-center justify-center gap-3 text-muted"
              data-testid="context-inspector-loading"
            >
              <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
              Loading redacted context state…
            </div>
          ) : error ? (
            <div
              className="rounded-xl border border-destructive/35 bg-destructive/5 p-5"
              data-testid="context-inspector-error"
              role="alert"
            >
              <div className="flex items-center gap-2 font-semibold text-txt">
                <AlertTriangle
                  className="h-5 w-5 text-destructive"
                  aria-hidden
                />
                Context state unavailable
              </div>
              <p className="mt-2 text-sm text-muted">{error}</p>
              <Button className="mt-4" size="sm" onClick={() => void load()}>
                Retry
              </Button>
            </div>
          ) : data ? (
            <>
              <BudgetSummary data={data} />
              {data.entries.length === 0 ? (
                <PagePanel.Empty
                  icon={<ScanSearch className="h-5 w-5" aria-hidden />}
                  title="No content references recorded"
                  description="This conversation has no inspectable progressive-content metadata on this page."
                />
              ) : (
                <div className="grid gap-3 lg:grid-cols-2">
                  {data.entries.map((entry) => (
                    <EntryCard
                      key={`${entry.reference}:${entry.range.unit}:${entry.range.start}:${entry.range.end}`}
                      entry={entry}
                    />
                  ))}
                </div>
              )}
              <nav
                className="flex items-center justify-between border-t border-border pt-4"
                aria-label="Context inspector pages"
              >
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!data.page.hasPrevious || loading}
                  onClick={() =>
                    setPagination({
                      conversationId: activeConversationId,
                      offset: Math.max(0, offset - data.page.limit),
                    })
                  }
                >
                  <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
                  Previous
                </Button>
                <span className="text-xs text-muted">
                  Trajectory window {data.page.offset + 1}–
                  {data.page.offset + data.page.limit}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={!data.page.hasMore || loading}
                  onClick={() =>
                    setPagination({
                      conversationId: activeConversationId,
                      offset: data.page.nextOffset ?? data.page.offset,
                    })
                  }
                >
                  Next
                  <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
                </Button>
              </nav>
            </>
          ) : null}
        </PagePanel.ContentArea>
      </PagePanel>
    </ShellViewAgentSurface>
  );
}
