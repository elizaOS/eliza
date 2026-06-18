/**
 * VincentSpatialView - the Vincent trading dashboard authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives plus type-only views of
 * the wallet and Vincent contracts, so it is safe to render in the Node agent
 * process where the terminal lives (no client/Capacitor runtime import).
 */

import type { WalletAddresses, WalletBalancesResponse } from "@elizaos/shared";
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
  VincentStrategy,
  VincentTradingProfile,
} from "../vincent-contracts.ts";

export interface VincentSnapshot {
  vincentConnected: boolean;
  vincentConnectedAt: number | null;
  walletAddresses: WalletAddresses | null;
  walletBalances: WalletBalancesResponse | null;
  strategy: VincentStrategy | null;
  tradingProfile: VincentTradingProfile | null;
  loading?: boolean;
  error?: string | null;
}

function shortAddress(address: string | null): string {
  if (!address) return "not set";
  if (address.length <= 14) return address;
  return `${address.slice(0, 6)}..${address.slice(-4)}`;
}

function strategyTone(strategy: VincentStrategy | null): SpatialTone {
  if (!strategy) return "muted";
  if (strategy.running) return "success";
  return "warning";
}

function pnlTone(totalPnl: string): SpatialTone {
  const value = Number.parseFloat(totalPnl);
  if (!Number.isFinite(value) || value === 0) return "muted";
  return value > 0 ? "success" : "danger";
}

function formatPnl(totalPnl: string): string {
  const value = Number.parseFloat(totalPnl);
  if (!Number.isFinite(value)) return totalPnl;
  const sign = value > 0 ? "+" : "";
  return `${sign}${totalPnl}`;
}

function formatWinRate(winRate: number): string {
  if (!Number.isFinite(winRate)) return "--";
  return `${Math.round(winRate * 100)}%`;
}

export interface VincentSpatialViewProps {
  snapshot: VincentSnapshot;
  /** Dispatch by agent id: `connect`, `disconnect`, `refresh`, `start`, `stop`. */
  onAction?: (action: string) => void;
}

export function VincentSpatialView({
  snapshot,
  onAction,
}: VincentSpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const {
    vincentConnected,
    walletAddresses,
    strategy,
    tradingProfile,
    loading,
    error,
  } = snapshot;

  return (
    <Card title="Vincent" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={vincentConnected ? "success" : "muted"}
          grow={1}
        >
          {vincentConnected ? "connected" : "disconnected"}
        </Text>
        <Text style="caption" tone="muted">
          {loading ? "loading" : "trading"}
        </Text>
      </HStack>

      {error ? (
        <Text tone="danger" style="caption">
          {error}
        </Text>
      ) : null}

      <Divider label="access" />
      {vincentConnected ? (
        <List gap={0}>
          <HStack gap={1} align="center" agent="wallet-evm">
            <Text style="caption" tone="muted" width={8}>
              evm
            </Text>
            <Text grow={1} wrap={false}>
              {shortAddress(walletAddresses?.evmAddress ?? null)}
            </Text>
          </HStack>
          <HStack gap={1} align="center" agent="wallet-solana">
            <Text style="caption" tone="muted" width={8}>
              sol
            </Text>
            <Text grow={1} wrap={false}>
              {shortAddress(walletAddresses?.solanaAddress ?? null)}
            </Text>
          </HStack>
        </List>
      ) : (
        <Text tone="muted" style="caption">
          Connect Vincent to trade on Hyperliquid and Polymarket.
        </Text>
      )}
      <HStack gap={1} wrap>
        {vincentConnected ? (
          <Button
            variant="outline"
            tone="danger"
            grow={1}
            agent="disconnect"
            onPress={dispatch("disconnect")}
          >
            Disconnect
          </Button>
        ) : (
          <Button grow={1} agent="connect" onPress={dispatch("connect")}>
            Connect
          </Button>
        )}
        <Button
          variant="ghost"
          tone="default"
          agent="refresh"
          onPress={dispatch("refresh")}
        >
          Refresh
        </Button>
      </HStack>

      <Divider label="strategy" />
      {strategy ? (
        <VStack gap={0}>
          <HStack gap={1} align="center">
            <Text bold grow={1} wrap={false}>
              {strategy.name}
            </Text>
            <Text style="caption" tone={strategyTone(strategy)}>
              {strategy.running ? "running" : "idle"}
            </Text>
          </HStack>
          <HStack gap={1} align="center">
            <Text style="caption" tone="muted" grow={1} wrap={false}>
              {strategy.venues.join(", ") || "no venues"}
            </Text>
            <Text style="caption" tone={strategy.dryRun ? "warning" : "muted"}>
              {strategy.dryRun ? "dry-run" : "live"}
            </Text>
          </HStack>
          <Text style="caption" tone="muted">
            interval {strategy.intervalSeconds}s
          </Text>
          {tradingProfile ? (
            <List gap={0}>
              <HStack gap={1} align="center">
                <Text style="caption" tone="muted" grow={1}>
                  pnl
                </Text>
                <Text
                  style="caption"
                  tone={pnlTone(tradingProfile.totalPnl)}
                  bold
                >
                  {formatPnl(tradingProfile.totalPnl)}
                </Text>
              </HStack>
              <HStack gap={1} align="center">
                <Text style="caption" tone="muted" grow={1}>
                  win rate
                </Text>
                <Text style="caption">
                  {formatWinRate(tradingProfile.winRate)}
                </Text>
              </HStack>
              <HStack gap={1} align="center">
                <Text style="caption" tone="muted" grow={1}>
                  swaps / vol24h
                </Text>
                <Text style="caption">
                  {tradingProfile.totalSwaps} / {tradingProfile.volume24h}
                </Text>
              </HStack>
              {tradingProfile.tokenBreakdown.length > 0 ? (
                <List gap={0}>
                  {tradingProfile.tokenBreakdown.slice(0, 6).map((token) => (
                    <HStack
                      key={token.symbol}
                      gap={1}
                      align="center"
                      agent={`token-${token.symbol}`}
                    >
                      <Text bold width={10} wrap={false}>
                        {token.symbol}
                      </Text>
                      <Text grow={1} tone={pnlTone(token.pnl)} wrap={false}>
                        {formatPnl(token.pnl)}
                      </Text>
                      <Text style="caption" tone="muted">
                        {token.swaps} swaps
                      </Text>
                    </HStack>
                  ))}
                </List>
              ) : null}
            </List>
          ) : (
            <Text tone="muted" style="caption">
              No P&amp;L data yet.
            </Text>
          )}
        </VStack>
      ) : (
        <Text tone="muted" align="center" style="caption">
          No strategy configured
        </Text>
      )}
    </Card>
  );
}
