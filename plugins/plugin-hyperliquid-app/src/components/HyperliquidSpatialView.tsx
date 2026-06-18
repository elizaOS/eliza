/**
 * HyperliquidSpatialView - the Hyperliquid dashboard authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus type-only views of
 * the Hyperliquid contracts, so it is safe to render in the Node agent process
 * where the terminal lives (no app-core/React-DOM runtime import).
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
  HyperliquidCredentialMode,
  HyperliquidMarket,
  HyperliquidOrder,
  HyperliquidPosition,
} from "../hyperliquid-contracts.ts";

export interface HyperliquidStatusSnapshot {
  publicReadReady: boolean;
  signerReady: boolean;
  executionReady: boolean;
  credentialMode: HyperliquidCredentialMode;
  accountAddress: string | null;
  vaultReady: boolean;
  executionBlockedReason: string | null;
}

export interface HyperliquidSnapshot {
  status: HyperliquidStatusSnapshot;
  markets: HyperliquidMarket[];
  positions: HyperliquidPosition[];
  orders: HyperliquidOrder[];
  loading?: boolean;
  error?: string | null;
}

function credentialModeLabel(mode: HyperliquidCredentialMode): string {
  switch (mode) {
    case "managed_vault":
      return "Managed vault";
    case "local_key":
      return "Local key";
    default:
      return "Read-only";
  }
}

function readinessTone(ready: boolean): SpatialTone {
  return ready ? "success" : "muted";
}

function readinessMark(ready: boolean): string {
  return ready ? "[ok]" : "[--]";
}

function StatusTile({ label, ready }: { label: string; ready: boolean }) {
  return (
    <HStack gap={1} align="center" grow={1}>
      <Text tone={readinessTone(ready)} wrap={false}>
        {readinessMark(ready)}
      </Text>
      <Text bold grow={1} wrap={false}>
        {label}
      </Text>
    </HStack>
  );
}

function shortAddress(address: string | null): string {
  if (!address) return "not configured";
  if (address.length <= 13) return address;
  return `${address.slice(0, 6)}..${address.slice(-4)}`;
}

export interface HyperliquidSpatialViewProps {
  snapshot: HyperliquidSnapshot;
  /** Dispatch by agent id: `refresh`, `back`. */
  onAction?: (action: string) => void;
}

export function HyperliquidSpatialView({
  snapshot,
  onAction,
}: HyperliquidSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const { status } = snapshot;
  const accountReady = Boolean(status.accountAddress);

  return (
    <Card title="Hyperliquid" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={status.publicReadReady ? "success" : "danger"}
          grow={1}
        >
          {snapshot.loading
            ? "loading"
            : status.publicReadReady
              ? "read-ready"
              : "read-blocked"}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          {snapshot.markets.length}m / {snapshot.positions.length}p /{" "}
          {snapshot.orders.length}o
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <Divider label="status" />
      <VStack gap={0}>
        <StatusTile label="Reads" ready={status.publicReadReady} />
        <StatusTile
          label={credentialModeLabel(status.credentialMode)}
          ready={status.signerReady}
        />
        <StatusTile
          label={accountReady ? "Account" : "No account"}
          ready={accountReady}
        />
      </VStack>

      {status.executionBlockedReason ? (
        <Text style="caption" tone="warning">
          {status.executionBlockedReason}
        </Text>
      ) : null}

      <Divider label="markets" />
      {snapshot.markets.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No markets
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.markets.slice(0, 12).map((market) => (
            <HStack
              key={market.name}
              gap={1}
              align="center"
              agent={`market-${market.name}`}
            >
              <Text
                bold
                grow={1}
                wrap={false}
                tone={market.isDelisted ? "muted" : "default"}
              >
                {market.name}
              </Text>
              <Text style="caption" tone="primary" wrap={false}>
                {market.maxLeverage ? `${market.maxLeverage}x` : "n/a"}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                sz{market.szDecimals}
                {market.onlyIsolated ? " iso" : ""}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="account" />
      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1} wrap={false}>
          {shortAddress(status.accountAddress)}
        </Text>
        <Text
          style="caption"
          tone={status.executionReady ? "success" : "muted"}
          wrap={false}
        >
          {status.executionReady ? "exec-ready" : "exec-off"}
        </Text>
      </HStack>

      <Text style="caption" tone="primary">
        positions
      </Text>
      {snapshot.positions.length === 0 ? (
        <Text tone="muted" style="caption">
          none
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.positions.slice(0, 6).map((position) => (
            <HStack
              key={position.coin}
              gap={1}
              align="center"
              agent={`position-${position.coin}`}
            >
              <Text bold grow={1} wrap={false}>
                {position.coin}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                sz {position.size}
              </Text>
              {position.unrealizedPnl ? (
                <Text
                  style="caption"
                  tone={
                    position.unrealizedPnl.trim().startsWith("-")
                      ? "danger"
                      : "success"
                  }
                  wrap={false}
                >
                  {position.unrealizedPnl}
                </Text>
              ) : null}
            </HStack>
          ))}
        </List>
      )}

      <Text style="caption" tone="primary">
        orders
      </Text>
      {snapshot.orders.length === 0 ? (
        <Text tone="muted" style="caption">
          none
        </Text>
      ) : (
        <List gap={0}>
          {snapshot.orders.slice(0, 6).map((order) => (
            <HStack
              key={order.oid}
              gap={1}
              align="center"
              agent={`order-${order.oid}`}
            >
              <Text bold wrap={false}>
                {order.coin}
              </Text>
              <Text
                style="caption"
                tone={
                  order.side.toLowerCase().startsWith("b")
                    ? "success"
                    : "danger"
                }
                wrap={false}
              >
                {order.side}
              </Text>
              <Text style="caption" tone="muted" grow={1} wrap={false}>
                {order.size} @ {order.limitPx}
              </Text>
              {order.reduceOnly ? (
                <Text style="caption" tone="warning" wrap={false}>
                  ro
                </Text>
              ) : null}
            </HStack>
          ))}
        </List>
      )}

      <Divider />
      <HStack gap={1} wrap>
        <Button grow={1} agent="refresh" onPress={dispatch("refresh")}>
          Refresh
        </Button>
        <Button
          variant="outline"
          tone="default"
          agent="back"
          onPress={dispatch("back")}
        >
          Back
        </Button>
      </HStack>
    </Card>
  );
}
