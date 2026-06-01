/**
 * StewardView — transaction history + approval queue panel.
 * Renders inside the Wallets tab as a sub-section or alongside inventory.
 */

import {
  PageLayout,
  PagePanel,
  Sidebar,
  SidebarContent,
  SidebarPanel,
  useAgentElement,
  useApp,
} from "@elizaos/ui";
import { FileText } from "lucide-react";
import type { ReactNode } from "react";
import { useCallback, useEffect, useState } from "react";
import { ApprovalQueue } from "./ApprovalQueue";
import { StewardLogo } from "./StewardLogo";
import { TransactionHistory } from "./TransactionHistory";
import type {
  StewardApprovalActionResponse,
  StewardPendingApproval,
  StewardStatusResponse,
  StewardTxRecord,
} from "./types/steward";

type StewardTab = "history" | "approvals";

function StewardTabItem({
  tab,
  label,
  description,
  active,
  onSelect,
  icon,
}: {
  tab: StewardTab;
  label: string;
  description: string;
  active: boolean;
  onSelect: (tab: StewardTab) => void;
  icon: ReactNode;
}) {
  const { ref, agentProps } = useAgentElement<HTMLElement>({
    id: `tab-${tab}`,
    role: "tab",
    label,
    group: "steward-tabs",
    status: active ? "active" : "inactive",
    description: `Switch to the ${label} view`,
  });
  return (
    <SidebarContent.Item
      ref={ref}
      active={active}
      onClick={() => onSelect(tab)}
      aria-current={active ? "true" : undefined}
      {...agentProps}
    >
      <SidebarContent.ItemIcon active={active} className="relative">
        {icon}
      </SidebarContent.ItemIcon>
      <SidebarContent.ItemBody>
        <SidebarContent.ItemTitle>{label}</SidebarContent.ItemTitle>
        <SidebarContent.ItemDescription>
          {description}
        </SidebarContent.ItemDescription>
      </SidebarContent.ItemBody>
    </SidebarContent.Item>
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
  } = useApp();

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

  // If steward isn't configured, show a placeholder
  if (stewardStatus && !stewardStatus.connected) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <PagePanel
          variant="surface"
          className="mx-4 w-full max-w-xl px-6 py-10 text-center"
        >
          <StewardLogo size={40} className="mx-auto opacity-40" />
          <h2 className="mt-4 text-lg font-semibold text-txt-strong">
            Steward Not Connected
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted leading-relaxed">
            Set STEWARD_API_URL and STEWARD_API_KEY in agent settings to enable
            vault management.
          </p>
          {stewardStatus.error && (
            <p className="mt-3 rounded-lg border border-danger/20 bg-danger/5 px-3 py-2 text-xs text-danger">
              {stewardStatus.error}
            </p>
          )}
        </PagePanel>
      </div>
    );
  }

  const stewardSidebar = (
    <Sidebar testId="steward-sidebar">
      <SidebarPanel>
        <SidebarContent.SectionLabel>Steward</SidebarContent.SectionLabel>
        <div className="mt-1.5 text-xs text-muted">
          {stewardStatus?.connected ? "Vault management" : "Connecting…"}
        </div>

        <nav className="mt-4 space-y-1.5">
          <StewardTabItem
            tab="approvals"
            label="Approvals"
            description={
              pendingCount > 0 ? `${pendingCount} pending` : "None pending"
            }
            active={activeTab === "approvals"}
            onSelect={setActiveTab}
            icon={
              <>
                <StewardLogo size={16} />
                {pendingCount > 0 && (
                  <span className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-status-danger px-1 text-3xs font-bold text-[var(--destructive-foreground)]">
                    {pendingCount > 99 ? "99+" : pendingCount}
                  </span>
                )}
              </>
            }
          />

          <StewardTabItem
            tab="history"
            label="History"
            description="All transactions"
            active={activeTab === "history"}
            onSelect={setActiveTab}
            icon={<FileText className="h-4 w-4" />}
          />
        </nav>

        {/* Steward status */}
        {stewardStatus?.connected && (
          <div className="mt-auto pt-4">
            <div className="inline-flex items-center gap-1.5 rounded-2xl border border-accent/25 bg-accent/10 px-3 py-2 text-xs-tight text-accent-fg">
              <StewardLogo size={12} />
              <span>Connected</span>
            </div>
            {stewardStatus.evmAddress && (
              <p className="mt-1.5 font-mono text-2xs text-muted/60">
                {stewardStatus.evmAddress.slice(0, 6)}…
                {stewardStatus.evmAddress.slice(-4)}
              </p>
            )}
          </div>
        )}
      </SidebarPanel>
    </Sidebar>
  );

  return (
    <PageLayout sidebar={stewardSidebar}>
      <div className="mx-auto max-w-[76rem]">
        {/* Header */}
        <PagePanel variant="surface" className="px-5 py-5 sm:px-6">
          <div className="text-xs-tight font-semibold uppercase tracking-[0.16em] text-muted">
            Steward
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-txt-strong">
            {activeTab === "approvals" ? "Approvals" : "Transaction History"}
          </h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            {activeTab === "approvals"
              ? "Transactions that need your sign-off."
              : "All signed and broadcast transactions from the vault."}
          </p>
        </PagePanel>

        {/* Content */}
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
    </PageLayout>
  );
}

interface StewardTxRecordsResponse {
  records: StewardTxRecord[];
  total: number;
  offset: number;
  limit: number;
}

async function stewardJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Steward request failed with ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

async function postStewardJson<T>(
  url: string,
  body: Record<string, unknown>,
): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message =
      data && typeof data === "object" && "error" in data
        ? String(data.error)
        : `Steward request failed with ${response.status}`;
    throw new Error(message);
  }
  return data as T;
}

async function loadStewardTuiState(): Promise<{
  status: StewardStatusResponse;
  pending: StewardPendingApproval[];
  history: StewardTxRecordsResponse | null;
}> {
  const status = await stewardJson<StewardStatusResponse>(
    "/api/wallet/steward-status",
  );

  if (!status.connected) {
    return { status, pending: [], history: null };
  }

  const [pending, history] = await Promise.all([
    stewardJson<StewardPendingApproval[]>(
      "/api/wallet/steward-pending-approvals",
    ),
    stewardJson<StewardTxRecordsResponse>(
      "/api/wallet/steward-tx-records?limit=25&offset=0",
    ),
  ]);

  return { status, pending, history };
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
        background: "#020617",
        color: "#cbd5e1",
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace',
        padding: 20,
      }}
    >
      <div style={{ color: "#7dd3fc", marginBottom: 4 }}>
        elizaos://steward --type=tui
      </div>
      <div style={{ color: "#475569", marginBottom: 16 }}>
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
          gridTemplateColumns: "minmax(320px, 1fr) minmax(320px, 1fr)",
          gap: 16,
        }}
      >
        <section
          aria-label="Steward approvals"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
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
            <strong style={{ color: "#e2e8f0" }}>pending approvals</strong>
            <button
              type="button"
              onClick={() => void refresh()}
              disabled={loading}
              style={{
                background: "transparent",
                color: "#a7f3d0",
                border: "1px solid rgba(167,243,208,0.45)",
                borderRadius: 4,
                padding: "4px 8px",
                cursor: loading ? "not-allowed" : "pointer",
                fontFamily: "inherit",
              }}
            >
              refresh
            </button>
          </div>
          {error && <div style={{ color: "#fca5a5" }}>{error}</div>}
          <div style={{ marginBottom: 12 }}>
            <div>
              <span style={{ color: "#64748b" }}>configured</span>{" "}
              {state?.status.configured ? "yes" : "no"}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>available</span>{" "}
              {state?.status.available ? "yes" : "no"}
            </div>
            <div>
              <span style={{ color: "#64748b" }}>evm</span>{" "}
              {state?.status.evmAddress ?? "no steward evm address"}
            </div>
            {state?.status.error ? (
              <div style={{ color: "#fca5a5" }}>{state.status.error}</div>
            ) : null}
          </div>
          {!state?.status.connected && !loading ? (
            <div style={{ color: "#94a3b8", marginTop: 18 }}>
              Set STEWARD_API_URL and STEWARD_API_KEY to enable vault approvals.
            </div>
          ) : null}
          {state?.pending.map((item) => (
            <div
              key={item.queueId}
              style={{
                borderTop: "1px solid rgba(125,211,252,0.14)",
                padding: "9px 0",
              }}
            >
              <div style={{ color: "#e2e8f0" }}>
                {item.transaction.id} / {item.transaction.status}
              </div>
              <div style={{ color: "#94a3b8" }}>
                chain {item.transaction.request.chainId} to{" "}
                {item.transaction.request.to} value{" "}
                {item.transaction.request.value}
              </div>
              <div style={{ color: "#64748b" }}>{item.requestedAt}</div>
            </div>
          ))}
        </section>

        <section
          aria-label="Steward transaction history"
          style={{
            border: "1px solid rgba(125,211,252,0.3)",
            borderRadius: 6,
            padding: 16,
            minHeight: 420,
          }}
        >
          <strong style={{ color: "#e2e8f0" }}>transaction history</strong>
          <div style={{ color: "#64748b", margin: "6px 0 14px" }}>
            commands: state | pending | history | approve | deny
          </div>
          {recent.map((tx) => (
            <div
              key={tx.id}
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0,1fr) 10ch",
                gap: 10,
                borderTop: "1px solid rgba(125,211,252,0.14)",
                padding: "8px 0",
              }}
            >
              <span style={{ color: "#e2e8f0" }}>{tx.id}</span>
              <span style={{ color: "#a7f3d0" }}>{tx.status}</span>
              <span style={{ gridColumn: "1 / 3", color: "#94a3b8" }}>
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

export async function interact(
  capability: string,
  params?: Record<string, unknown>,
): Promise<unknown> {
  if (capability === "terminal-steward-state") {
    return { viewType: "tui", ...(await loadStewardTuiState()) };
  }

  if (capability === "terminal-steward-pending") {
    return {
      viewType: "tui",
      pending: await stewardJson<StewardPendingApproval[]>(
        "/api/wallet/steward-pending-approvals",
      ),
    };
  }

  if (capability === "terminal-steward-history") {
    const status = typeof params?.status === "string" ? params.status : "";
    const limit = typeof params?.limit === "number" ? params.limit : 50;
    const offset = typeof params?.offset === "number" ? params.offset : 0;
    const search = new URLSearchParams({
      limit: String(limit),
      offset: String(offset),
    });
    if (status) search.set("status", status);
    return {
      viewType: "tui",
      history: await stewardJson<StewardTxRecordsResponse>(
        `/api/wallet/steward-tx-records?${search}`,
      ),
    };
  }

  if (
    capability === "terminal-steward-approve" ||
    capability === "terminal-steward-deny"
  ) {
    const txId = typeof params?.txId === "string" ? params.txId.trim() : "";
    if (!txId) throw new Error("txId is required");
    const deny = capability === "terminal-steward-deny";
    return {
      viewType: "tui",
      result: await postStewardJson<StewardApprovalActionResponse>(
        deny ? "/api/wallet/steward-deny-tx" : "/api/wallet/steward-approve-tx",
        {
          txId,
          reason:
            typeof params?.reason === "string" ? params.reason : undefined,
        },
      ),
    };
  }

  throw new Error(`Unsupported capability "${capability}"`);
}
