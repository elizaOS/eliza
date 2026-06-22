/**
 * StewardView — the single GUI/XR data wrapper for the Steward surface.
 *
 * It owns the live vault data (status, pending approvals, transaction history)
 * read through the app store accessors, builds one {@link StewardSnapshot}, and
 * renders the one presentational {@link StewardSpatialView} inside a
 * {@link SpatialSurface}. Omitting the `modality` prop lets `SpatialSurface`
 * auto-detect GUI vs XR via `window.__elizaXRContext`, so the SAME component
 * serves both surfaces. The TUI surface renders the same `StewardSpatialView`
 * through the terminal registry (see `register-terminal-view.tsx`).
 */

import { useAppSelectorShallow } from "@elizaos/ui";
import { SpatialSurface } from "@elizaos/ui/spatial";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type StewardHistoryRow,
  StewardSpatialView,
  type StewardSnapshot,
  toStewardApprovalRow,
  toStewardHistoryRow,
} from "./components/StewardSpatialView.tsx";
import type {
  StewardApprovalActionResponse,
  StewardPendingApproval,
  StewardStatusResponse,
  StewardTxRecord,
} from "./types/steward";

type StewardTab = "approvals" | "history";

const PAGE_SIZE = 25;

/** Status filter cycle for the history tab (null = all). */
const STATUS_CYCLE: Array<string | null> = [
  null,
  "pending",
  "signed",
  "broadcast",
  "confirmed",
  "rejected",
  "failed",
];

/** Chain filter cycle for the history tab (null = all). */
const CHAIN_CYCLE: Array<number | null> = [
  null,
  1,
  8453,
  56,
  137,
  42161,
  101,
];

function nextInCycle<T>(cycle: T[], current: T): T {
  const idx = cycle.findIndex((value) => value === current);
  return cycle[(idx + 1) % cycle.length];
}

interface StewardStore {
  getStewardStatus: () => Promise<StewardStatusResponse>;
  getStewardHistory: (opts?: {
    status?: string;
    limit?: number;
    offset?: number;
  }) => Promise<{
    records: StewardTxRecord[];
    total: number;
    offset: number;
    limit: number;
  }>;
  getStewardPending: () => Promise<StewardPendingApproval[]>;
  approveStewardTx: (txId: string) => Promise<StewardApprovalActionResponse>;
  rejectStewardTx: (
    txId: string,
    reason?: string,
  ) => Promise<StewardApprovalActionResponse>;
  copyToClipboard: (text: string) => Promise<void>;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
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
  } = useAppSelectorShallow((s: StewardStore) => ({
    getStewardStatus: s.getStewardStatus,
    getStewardHistory: s.getStewardHistory,
    getStewardPending: s.getStewardPending,
    approveStewardTx: s.approveStewardTx,
    rejectStewardTx: s.rejectStewardTx,
    copyToClipboard: s.copyToClipboard,
    setActionNotice: s.setActionNotice,
  }));

  const [tab, setTab] = useState<StewardTab>("approvals");
  const [status, setStatus] = useState<StewardStatusResponse | null>(null);
  const [pending, setPending] = useState<StewardPendingApproval[]>([]);
  const [history, setHistory] = useState<StewardTxRecord[]>([]);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [chainFilter, setChainFilter] = useState<number | null>(null);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const prevCountRef = useRef(0);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getStewardStatus();
      setStatus(next);
      if (!next.connected) {
        setPending([]);
        setHistory([]);
        return;
      }
      const [nextPending, historyResult] = await Promise.all([
        getStewardPending(),
        getStewardHistory({
          status: statusFilter ?? undefined,
          limit: 200,
          offset: 0,
        }),
      ]);
      const pendingList = Array.isArray(nextPending) ? nextPending : [];
      const prevCount = prevCountRef.current;
      if (pendingList.length > prevCount && prevCount > 0) {
        const delta = pendingList.length - prevCount;
        setActionNotice(
          `${delta} new approval${delta > 1 ? "s" : ""} pending`,
          "info",
          3000,
        );
      }
      prevCountRef.current = pendingList.length;
      setPending(pendingList);
      setHistory(historyResult.records ?? []);
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Steward refresh failed",
      );
    } finally {
      setLoading(false);
    }
  }, [
    getStewardStatus,
    getStewardPending,
    getStewardHistory,
    statusFilter,
    setActionNotice,
  ]);

  // Initial load + a quiet 20s poll, torn down on unmount.
  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(interval);
  }, [refresh]);

  const handleApprove = useCallback(
    async (queueId: string) => {
      const entry = pending.find((item) => item.queueId === queueId);
      const txId = entry?.transaction.id;
      if (!txId) return;
      try {
        const result = await approveStewardTx(txId);
        if (result.ok !== false) {
          setActionNotice("Transaction approved", "success", 3000);
          setPending((prev) =>
            prev.filter((item) => item.queueId !== queueId),
          );
          prevCountRef.current = Math.max(0, prevCountRef.current - 1);
        } else {
          setActionNotice(result.error ?? "Approval failed", "error", 4000);
        }
      } catch (caught) {
        setActionNotice(
          caught instanceof Error ? caught.message : "Approval failed",
          "error",
          4000,
        );
      }
    },
    [pending, approveStewardTx, setActionNotice],
  );

  const handleReject = useCallback(
    async (queueId: string) => {
      const entry = pending.find((item) => item.queueId === queueId);
      const txId = entry?.transaction.id;
      if (!txId) return;
      try {
        const result = await rejectStewardTx(txId);
        if (result.ok !== false) {
          setActionNotice("Transaction rejected", "info", 3000);
          setPending((prev) =>
            prev.filter((item) => item.queueId !== queueId),
          );
          prevCountRef.current = Math.max(0, prevCountRef.current - 1);
        } else {
          setActionNotice(result.error ?? "Rejection failed", "error", 4000);
        }
      } catch (caught) {
        setActionNotice(
          caught instanceof Error ? caught.message : "Rejection failed",
          "error",
          4000,
        );
      }
    },
    [pending, rejectStewardTx, setActionNotice],
  );

  const handleCopy = useCallback(
    async (value: string) => {
      if (!value) return;
      await copyToClipboard(value);
      setActionNotice("Address copied", "success", 2000);
    },
    [copyToClipboard, setActionNotice],
  );

  const onAction = useCallback(
    (action: string) => {
      if (action.startsWith("approve:")) {
        void handleApprove(action.slice("approve:".length));
        return;
      }
      if (action.startsWith("reject:")) {
        void handleReject(action.slice("reject:".length));
        return;
      }
      if (action.startsWith("copy:")) {
        void handleCopy(action.slice("copy:".length));
        return;
      }
      switch (action) {
        case "tab:approvals":
          setTab("approvals");
          return;
        case "tab:history":
          setTab("history");
          return;
        case "refresh":
          void refresh();
          return;
        case "filter-status":
          setStatusFilter((current) => nextInCycle(STATUS_CYCLE, current));
          setPage(0);
          return;
        case "filter-chain":
          setChainFilter((current) => nextInCycle(CHAIN_CYCLE, current));
          setPage(0);
          return;
        case "page-prev":
          setPage((p) => Math.max(0, p - 1));
          return;
        case "page-next":
          setPage((p) => p + 1);
          return;
      }
    },
    [handleApprove, handleReject, handleCopy, refresh],
  );

  // Client-side chain filter + newest-first sort, then paginate.
  const filteredHistory = useMemo(() => {
    const rows: StewardHistoryRow[] = history
      .filter(
        (tx) => chainFilter === null || tx.request.chainId === chainFilter,
      )
      .map(toStewardHistoryRow)
      .sort(
        (a, b) =>
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      );
    return rows;
  }, [history, chainFilter]);

  const pageCount = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE));
  const clampedPage = Math.min(page, pageCount - 1);
  const pageRows = filteredHistory.slice(
    clampedPage * PAGE_SIZE,
    (clampedPage + 1) * PAGE_SIZE,
  );

  const snapshot: StewardSnapshot = {
    tab,
    connected: status?.connected ?? false,
    configured: status?.configured ?? false,
    available: status?.available ?? false,
    evmAddress: status?.evmAddress ?? null,
    pendingApprovals: pending.map(toStewardApprovalRow),
    history: pageRows,
    historyTotal: filteredHistory.length,
    statusFilter,
    chainFilter,
    page: clampedPage,
    pageSize: PAGE_SIZE,
    loading,
    error: error ?? status?.error ?? null,
  };

  return (
    <SpatialSurface>
      <StewardSpatialView snapshot={snapshot} onAction={onAction} />
    </SpatialSurface>
  );
}
