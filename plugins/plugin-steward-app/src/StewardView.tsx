/**
 * StewardView — transaction history + approval queue panel.
 * Renders inside the Wallets tab as a sub-section or alongside inventory.
 */

import { cn, PagePanel, useAppSelectorShallow } from "@elizaos/ui";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { ApprovalQueue } from "./ApprovalQueue";
import { StewardLogo } from "./StewardLogo";
import { loadStewardTuiState } from "./StewardView.helpers";
import { TransactionHistory } from "./TransactionHistory";
import type { StewardStatusResponse } from "./types/steward";

type StewardTab = "history" | "approvals";

function StewardTabItem({
  tab,
  label,
  active,
  onSelect,
  icon,
}: {
  tab: StewardTab;
  label: string;
  active: boolean;
  onSelect: (tab: StewardTab) => void;
  icon: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLButtonElement>({
    id: `tab-${tab}`,
    role: "tab",
    label,
    group: "steward-tabs",
    status: active ? "active" : "inactive",
    description: `Switch to the ${label} view`,
  });
  return (
    <button
      ref={ref}
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(tab)}
      className={cn(
        "inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg px-3 text-sm font-medium transition-colors sm:flex-none",
        active
          ? "bg-bg-elevated text-txt-strong"
          : "text-muted hover:bg-bg-hover hover:text-txt-strong",
      )}
      {...agentProps}
    >
      <span className="relative inline-flex">{icon}</span>
      <span>{label}</span>
    </button>
  );
}

export function StewardView() {
  const {
    getStewardStatus,
    getStewardHistory,
    getStewardPending,
    approveStewardTx,
    rejectStewardTx,
    copyToClipboard,
    setActionNotice,
  } = useAppSelectorShallow((s) => ({
    getStewardStatus: s.getStewardStatus,
    getStewardHistory: s.getStewardHistory,
    getStewardPending: s.getStewardPending,
    approveStewardTx: s.approveStewardTx,
    rejectStewardTx: s.rejectStewardTx,
    copyToClipboard: s.copyToClipboard,
    setActionNotice: s.setActionNotice,
  }));

  const [activeTab, setActiveTab] = useState<StewardTab>("approvals");
  const [stewardStatus, setStewardStatus] =
    useState<StewardStatusResponse | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    if (typeof getStewardStatus !== "function") return;
    let cancelled = false;
    getStewardStatus()
      .then((s) => {
        if (!cancelled) setStewardStatus(s);
      })
      .catch(() => {
        /* steward not available */
      });
    return () => {
      cancelled = true;
    };
  }, [getStewardStatus]);

  const handlePendingCountChange = useCallback((count: number) => {
    setPendingCount(count);
  }, []);

  // If steward isn't configured, show the empty-state panel.
  if (stewardStatus && !stewardStatus.connected) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <PagePanel
          variant="surface"
          className="mx-4 w-full max-w-md px-5 py-6 text-center"
        >
          <StewardLogo size={36} className="mx-auto opacity-50" />
          <h2 className="mt-3 text-base font-semibold text-txt-strong">
            Steward disconnected
          </h2>
          <div className="mt-2 font-mono text-xs text-muted">
            STEWARD_API_URL + STEWARD_API_KEY
          </div>
          {stewardStatus.error && (
            <div className="mt-3 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger">
              {stewardStatus.error}
            </div>
          )}
        </PagePanel>
      </div>
    );
  }

  return (
    <div
      data-testid="steward-view"
      className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-4 py-4"
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-bg-accent">
            <StewardLogo size={18} />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-base font-semibold text-txt-strong">
              {activeTab === "approvals" ? "Approvals" : "History"}
            </h1>
            {stewardStatus?.evmAddress ? (
              <div className="font-mono text-2xs text-muted">
                {stewardStatus.evmAddress.slice(0, 6)}...
                {stewardStatus.evmAddress.slice(-4)}
              </div>
            ) : null}
          </div>
        </div>

        {stewardStatus?.connected ? (
          <div className="inline-flex shrink-0 items-center gap-1.5 rounded-full bg-accent/10 px-2.5 py-1.5 text-xs-tight text-accent-fg">
            <StewardLogo size={12} />
            <span>Connected</span>
          </div>
        ) : (
          <div className="shrink-0 text-xs text-muted">
            {stewardStatus ? "Offline" : "Connecting..."}
          </div>
        )}
      </div>

      <div
        role="tablist"
        aria-label="Steward sections"
        className="mt-3 inline-flex w-full items-center gap-1 sm:w-auto sm:self-start"
      >
        <StewardTabItem
          tab="approvals"
          label="Approvals"
          active={activeTab === "approvals"}
          onSelect={setActiveTab}
          icon={
            <>
              <StewardLogo size={16} />
              {pendingCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-danger px-1 text-3xs font-bold text-[var(--destructive-foreground)]">
                  {pendingCount > 99 ? "99+" : pendingCount}
                </span>
              )}
            </>
          }
        />
        <StewardTabItem
          tab="history"
          label="History"
          active={activeTab === "history"}
          onSelect={setActiveTab}
          icon={<FileText className="h-4 w-4" />}
        />
      </div>

      <div className="mt-4">
        {activeTab === "approvals" ? (
          <ApprovalQueue
            getStewardPending={getStewardPending}
            approveStewardTx={approveStewardTx}
            rejectStewardTx={rejectStewardTx}
            copyToClipboard={copyToClipboard}
            setActionNotice={setActionNotice}
            onPendingCountChange={handlePendingCountChange}
          />
        ) : (
          <TransactionHistory
            getStewardHistory={getStewardHistory}
            copyToClipboard={copyToClipboard}
            setActionNotice={setActionNotice}
          />
        )}
      </div>
    </div>
  );
}

export function StewardTuiView() {
  const [state, setState] = useState<Awaited<
    ReturnType<typeof loadStewardTuiState>
  > | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastAction, setLastAction] = useState("boot");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await loadStewardTuiState();
      setState(next);
      setLastAction("refresh");
    } catch (caught) {
      setState(null);
      setError(
        caught instanceof Error ? caught.message : "Steward refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const recent = state?.history?.records ?? [];
  const viewState = {
    viewType: "tui",
    viewId: "steward",
    connected: state?.status.connected ?? false,
    configured: state?.status.configured ?? false,
    available: state?.status.available ?? false,
    evmAddress: state?.status.evmAddress ?? null,
    pendingCount: state?.pending.length ?? 0,
    historyCount: state?.history?.total ?? 0,
    loading,
    lastAction,
    error,
  };

  return (
    <div
      data-view-state={JSON.stringify(viewState)}
      style={{
        minHeight: "100vh",
        background: "var(--background, #eef8ff)",
        color: "var(--foreground, #0a0a0a)",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "var(--accent, #ff8a24)", marginBottom: 4 }}>
        elizaos://steward --type=tui
      </div>
      <div style={{ color: "var(--muted-foreground, #6b7280)", marginBottom: 16 }}>
        {loading
          ? "loading"
          : state?.status.connected
            ? "connected"
            : "not-connected"}{" "}
        | {state?.pending.length ?? 0} pending | {recent.length} history |{" "}
        {lastAction}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr",
          gap: 16,
        }}
      >
        <section
          aria-label="Steward approvals"
          style={{
            border: "1px solid var(--border, rgba(10,10,10,0.1))",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "var(--foreground, #0a0a0a)" }}>
              pending approvals
            </strong>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "var(--accent, #ff8a24)",
                border: "1px solid var(--accent, #ff8a24)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              refresh
            </button>
          </div>
          {error && (
            <div style={{ color: "var(--destructive, #ef4444)" }}>{error}</div>
          )}
          <div style={{ marginBottom: 12 }}>
            <div>
              <span style={{ color: "var(--muted-foreground, #6b7280)" }}>
                configured
              </span>{" "}
              {state?.status.configured ? "yes" : "no"}
            </div>
            <div>
              <span style={{ color: "var(--muted-foreground, #6b7280)" }}>
                available
              </span>{" "}
              {state?.status.available ? "yes" : "no"}
            </div>
            <div>
              <span style={{ color: "var(--muted-foreground, #6b7280)" }}>
                evm
              </span>{" "}
              {state?.status.evmAddress ?? "no steward evm address"}
            </div>
            {state?.status.error ? (
              <div style={{ color: "var(--destructive, #ef4444)" }}>
                {state.status.error}
              </div>
            ) : null}
          </div>
          {!state?.status.connected && !loading ? (
            <div
              style={{ color: "var(--muted-foreground, #6b7280)", marginTop: 18 }}
            >
              Set STEWARD_API_URL and STEWARD_API_KEY to enable vault approvals.
            </div>
          ) : null}
          {state?.pending.map((item) => (
            <div
              key={item.queueId}
              style={{
                borderTop: "1px solid var(--border, rgba(10,10,10,0.08))",
                padding: "9px 0",
              }}
            >
              <div style={{ color: "var(--foreground, #0a0a0a)" }}>
                {item.transaction.id} / {item.transaction.status}
              </div>
              <div style={{ color: "var(--muted-foreground, #6b7280)" }}>
                chain {item.transaction.request.chainId} to{" "}
                {item.transaction.request.to} value{" "}
                {item.transaction.request.value}
              </div>
              <div style={{ color: "var(--muted-foreground, #6b7280)" }}>
                {item.requestedAt}
              </div>
            </div>
          ))}
        </section>

        <section
          aria-label="Steward transaction history"
          style={{
            border: "1px solid var(--border, rgba(10,10,10,0.1))",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "var(--foreground, #0a0a0a)" }}>
            transaction history
          </strong>
          <div
            style={{
              color: "var(--muted-foreground, #6b7280)",
              margin: "6px 0 14px",
            }}
          >
            {state?.pending.length ?? 0} pending / {recent.length} recent
          </div>
          {recent.slice(0, 8).map((tx) => (
            <div
              key={tx.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) 10ch",
                gap: 10,
                borderTop: "1px solid var(--border, rgba(10,10,10,0.08))",
                padding: "8px 0",
              }}
            >
              <span style={{ color: "var(--foreground, #0a0a0a)" }}>
                {tx.id}
              </span>
              <span style={{ color: "var(--muted-foreground, #6b7280)" }}>
                {tx.status}
              </span>
              <span
                style={{
                  gridColumn: "1 / 3",
                  color: "var(--muted-foreground, #6b7280)",
                }}
              >
                chain {tx.request.chainId} to {tx.request.to}
                {tx.txHash ? ` hash ${tx.txHash}` : ""}
              </span>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
