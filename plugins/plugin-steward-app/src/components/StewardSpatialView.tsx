/**
 * StewardSpatialView — the Steward approvals + history panel authored once with
 * the spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus type-only views of
 * the Steward response shapes, so it is safe to render in the Node agent process
 * where the terminal lives (no browser/app-runtime import).
 */

import {
  Button,
  Card,
  Divider,
  HStack,
  List,
  type SpatialTone,
  Text,
  VStack,
} from "@elizaos/ui/spatial";
import type {
  StewardPendingApproval,
  StewardTxRecord,
  StewardTxStatus,
} from "../types/steward.ts";

/** A pending-approval row in the snapshot (mirrors the loopback pending shape). */
export interface StewardApprovalRow {
  queueId: string;
  requestedAt: string;
  txId: string;
  status: string;
  chainId: number;
  to: string;
  value: string;
  /** Count of policy results attached to the transaction. */
  policyCount: number;
}

/** A history row in the snapshot (mirrors the loopback tx-record shape). */
export interface StewardHistoryRow {
  id: string;
  createdAt: string;
  status: StewardTxStatus;
  chainId: number;
  to: string;
  value: string;
  txHash?: string;
}

export interface StewardSnapshot {
  /** Active tab — Approvals or History. */
  tab: "approvals" | "history";
  connected: boolean;
  configured: boolean;
  available: boolean;
  evmAddress: string | null;
  pendingApprovals: StewardApprovalRow[];
  history: StewardHistoryRow[];
  /** Total history records (for pagination, not the visible slice length). */
  historyTotal: number;
  /** Active history filters. */
  statusFilter: string | null;
  chainFilter: number | null;
  /** 0-based page index. */
  page: number;
  pageSize: number;
  loading?: boolean;
  error?: string | null;
}

const PAGE_SIZE = 25;

function statusTone(status: string): SpatialTone {
  switch (status) {
    case "confirmed":
    case "broadcast":
    case "approved":
    case "signed":
      return "success";
    case "failed":
    case "rejected":
      return "danger";
    case "pending":
      return "warning";
    default:
      return "muted";
  }
}

function shortAddress(value: string | null | undefined): string {
  if (!value) return "no steward evm address";
  if (value.length <= 12) return value;
  return `${value.slice(0, 6)}..${value.slice(-4)}`;
}

/** Map a native pending-approval entry to the presentational row shape. */
export function toStewardApprovalRow(
  entry: StewardPendingApproval,
): StewardApprovalRow {
  const tx = entry.transaction;
  return {
    queueId: entry.queueId,
    requestedAt: entry.requestedAt,
    txId: tx.id,
    status: tx.status,
    chainId: tx.request.chainId,
    to: tx.request.to,
    value: tx.request.value,
    policyCount: tx.policyResults.length,
  };
}

/** Map a native tx record to the presentational history row shape. */
export function toStewardHistoryRow(
  record: StewardTxRecord,
): StewardHistoryRow {
  return {
    id: record.id,
    createdAt: record.createdAt,
    status: record.status,
    chainId: record.request.chainId,
    to: record.request.to,
    value: record.request.value,
    txHash: record.txHash,
  };
}

export interface StewardSpatialViewProps {
  snapshot: StewardSnapshot;
  /**
   * Dispatch by agent id: `tab:approvals`, `tab:history`, `refresh`,
   * `approve:<queueId>`, `reject:<queueId>`, `copy:<txId>`,
   * `filter-status`, `filter-chain`, `page-prev`, `page-next`.
   */
  onAction?: (action: string) => void;
}

function StatusLine({ label, value }: { label: string; value: string }) {
  return (
    <HStack gap={1} align="center">
      <Text style="caption" tone="muted">
        {label}
      </Text>
      <Text style="caption" grow={1} wrap={false}>
        {value}
      </Text>
    </HStack>
  );
}

function ApprovalsBody({
  snapshot,
  dispatch,
}: {
  snapshot: StewardSnapshot;
  dispatch: (action: string) => () => void;
}) {
  return (
    <VStack gap={1} width="100%">
      <StatusLine
        label="configured"
        value={snapshot.configured ? "yes" : "no"}
      />
      <StatusLine label="available" value={snapshot.available ? "yes" : "no"} />
      <StatusLine label="evm" value={shortAddress(snapshot.evmAddress)} />

      {!snapshot.connected && !snapshot.loading ? (
        <Text tone="muted" style="caption" wrap>
          Set STEWARD_API_URL and STEWARD_API_KEY to enable vault approvals.
        </Text>
      ) : null}

      <Divider label="pending approvals" />
      {snapshot.pendingApprovals.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          {snapshot.loading ? "loading" : "No pending approvals"}
        </Text>
      ) : (
        <List gap={1} width="100%">
          {snapshot.pendingApprovals.map((item) => (
            <VStack
              key={item.queueId}
              gap={0}
              width="100%"
              agent={`approval-${item.queueId}`}
            >
              <HStack gap={1} align="center" width="100%">
                <Text bold grow={1} wrap={false}>
                  {item.txId}
                </Text>
                <Text style="caption" tone={statusTone(item.status)}>
                  {item.status}
                </Text>
              </HStack>
              <Text style="caption" tone="muted" wrap={false}>
                chain {item.chainId} to {item.to}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                value {item.value} | {item.policyCount} policy
              </Text>
              <HStack gap={1} width="100%">
                <Button
                  tone="success"
                  grow={1}
                  agent={`approve-${item.queueId}`}
                  onPress={dispatch(`approve:${item.queueId}`)}
                >
                  Approve
                </Button>
                <Button
                  variant="outline"
                  tone="danger"
                  grow={1}
                  agent={`reject-${item.queueId}`}
                  onPress={dispatch(`reject:${item.queueId}`)}
                >
                  Reject
                </Button>
              </HStack>
            </VStack>
          ))}
        </List>
      )}
    </VStack>
  );
}

function HistoryBody({
  snapshot,
  dispatch,
}: {
  snapshot: StewardSnapshot;
  dispatch: (action: string) => () => void;
}) {
  const pageSize = snapshot.pageSize || PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(snapshot.historyTotal / pageSize));
  const pageLabel = `page ${snapshot.page + 1}/${totalPages}`;
  return (
    <VStack gap={1} width="100%">
      <HStack gap={1} align="center" width="100%">
        <Text style="caption" tone="muted" grow={1}>
          {snapshot.historyTotal} records
        </Text>
        <Button
          variant="outline"
          tone="default"
          agent="filter-status"
          onPress={dispatch("filter-status")}
        >
          status: {snapshot.statusFilter ?? "all"}
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="filter-chain"
          onPress={dispatch("filter-chain")}
        >
          chain: {snapshot.chainFilter ?? "all"}
        </Button>
      </HStack>

      <Divider label="transaction history" />
      {snapshot.history.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          {snapshot.loading ? "loading" : "No transactions"}
        </Text>
      ) : (
        <List gap={1} width="100%">
          {snapshot.history.map((tx) => (
            <VStack key={tx.id} gap={0} width="100%" agent={`tx-${tx.id}`}>
              <HStack gap={1} align="center" width="100%">
                <Text bold grow={1} wrap={false}>
                  {tx.id}
                </Text>
                <Text style="caption" tone={statusTone(tx.status)}>
                  {tx.status}
                </Text>
                <Button
                  variant="ghost"
                  tone="default"
                  agent={`copy-${tx.id}`}
                  onPress={dispatch(`copy:${tx.id}`)}
                >
                  Copy
                </Button>
              </HStack>
              <Text style="caption" tone="muted" wrap={false}>
                chain {tx.chainId} to {tx.to}
              </Text>
              {tx.txHash ? (
                <Text style="caption" tone="muted" wrap={false}>
                  hash {tx.txHash}
                </Text>
              ) : null}
            </VStack>
          ))}
        </List>
      )}

      <HStack gap={1} align="center" width="100%">
        <Button
          variant="outline"
          tone="default"
          disabled={snapshot.page <= 0}
          agent="page-prev"
          onPress={dispatch("page-prev")}
        >
          Prev
        </Button>
        <Text style="caption" tone="muted" align="center" grow={1}>
          {pageLabel}
        </Text>
        <Button
          variant="outline"
          tone="default"
          disabled={snapshot.page + 1 >= totalPages}
          agent="page-next"
          onPress={dispatch("page-next")}
        >
          Next
        </Button>
      </HStack>
    </VStack>
  );
}

export function StewardSpatialView({
  snapshot,
  onAction,
}: StewardSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const title = snapshot.tab === "approvals" ? "Approvals" : "History";
  return (
    <Card title="Steward" gap={1} padding={1}>
      <HStack gap={1} align="center" width="100%">
        <Text
          style="caption"
          tone={snapshot.connected ? "success" : "danger"}
          grow={1}
        >
          {snapshot.connected ? "connected" : "not-connected"}
        </Text>
        <Text style="caption" tone="muted">
          {shortAddress(snapshot.evmAddress)}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption" wrap>
          {snapshot.error}
        </Text>
      ) : null}

      <HStack gap={1} width="100%" wrap>
        <Button
          variant={snapshot.tab === "approvals" ? "solid" : "outline"}
          tone={snapshot.tab === "approvals" ? "primary" : "default"}
          grow={1}
          agent="tab-approvals"
          onPress={dispatch("tab:approvals")}
        >
          Approvals ({snapshot.pendingApprovals.length})
        </Button>
        <Button
          variant={snapshot.tab === "history" ? "solid" : "outline"}
          tone={snapshot.tab === "history" ? "primary" : "default"}
          grow={1}
          agent="tab-history"
          onPress={dispatch("tab:history")}
        >
          History ({snapshot.historyTotal})
        </Button>
        <Button
          variant="ghost"
          tone="default"
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          {snapshot.loading ? "..." : "Refresh"}
        </Button>
      </HStack>

      <Divider label={title} />

      {snapshot.tab === "approvals" ? (
        <ApprovalsBody snapshot={snapshot} dispatch={dispatch} />
      ) : (
        <HistoryBody snapshot={snapshot} dispatch={dispatch} />
      )}
    </Card>
  );
}
