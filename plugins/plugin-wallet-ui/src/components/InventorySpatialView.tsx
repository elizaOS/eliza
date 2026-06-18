/**
 * InventorySpatialView - the wallet inventory surface authored once with the
 * spatial vocabulary, so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR - mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      - rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no wallet RPC client or
 * `@elizaos/ui` runtime hook import). The big DOM `InventoryView` is unchanged;
 * this is an additive, render-anywhere mirror of the same data.
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

/** A single token holding, pre-formatted for display. */
export interface WalletTokenRow {
  id: string;
  symbol: string;
  chain: string;
  /** Pre-formatted human balance, e.g. "1.25". */
  balance: string;
  /** USD value of the holding. */
  valueUsd: number;
  contractAddress: string | null;
  logoUrl: string | null;
}

/** A single NFT, pre-formatted for display. */
export interface WalletNftRow {
  id: string;
  chain: string;
  collectionName: string;
  name: string;
  imageUrl: string;
}

/** A market mover, pre-formatted for display. */
export interface WalletMarketMover {
  id: string;
  symbol: string;
  priceUsd: number;
  change24hPct: number;
}

/** A recent swap from the trading profile. */
export interface WalletRecentSwap {
  id: string;
  /** Display label, e.g. "BNB -> CAKE". */
  pair: string;
  /** Pre-formatted relative/short time. */
  when: string;
}

export interface WalletAddresses {
  evmAddress: string | null;
  solanaAddress: string | null;
}

export interface WalletConfig {
  evmBalanceReady: boolean;
  solanaBalanceReady: boolean;
  selectedRpcProviders: string[];
}

export interface WalletTradingProfile {
  realizedPnlBnb: number;
  recentSwaps: WalletRecentSwap[];
}

export interface WalletSnapshot {
  portfolioValueUsd: number;
  tokenRows: WalletTokenRow[];
  walletNfts: WalletNftRow[];
  marketMovers: WalletMarketMover[];
  tradingProfile: WalletTradingProfile;
  addresses: WalletAddresses;
  config: WalletConfig;
  loading?: boolean;
  error?: string | null;
}

/** Wallet sections the agent can switch between, mirroring the GUI tabs. */
const TAB_KEYS = ["tokens", "defi", "nfts"] as const;

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (Math.abs(value) >= 1000) {
    return `$${value.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  }
  return `$${value.toFixed(2)}`;
}

function shortAddress(address: string | null): string {
  if (!address) return "-";
  if (address.length <= 12) return address;
  return `${address.slice(0, 6)}..${address.slice(-4)}`;
}

function changeTone(pct: number): SpatialTone {
  if (pct > 0) return "success";
  if (pct < 0) return "danger";
  return "muted";
}

function changeMark(pct: number): string {
  if (pct > 0) return "+";
  if (pct < 0) return "-";
  return ".";
}

function pnlTone(value: number): SpatialTone {
  if (value > 0) return "success";
  if (value < 0) return "danger";
  return "muted";
}

export interface InventorySpatialViewProps {
  snapshot: WalletSnapshot;
  /** Dispatch by agent id: `tab:<id>`, `refresh`, `token:<id>`, `nft:<id>`. */
  onAction?: (action: string) => void;
}

export function InventorySpatialView({
  snapshot,
  onAction,
}: InventorySpatialViewProps) {
  const dispatch = (action: string) => () => onAction?.(action);
  const {
    portfolioValueUsd,
    tokenRows,
    walletNfts,
    marketMovers,
    tradingProfile,
    addresses,
    config,
  } = snapshot;
  const rpc =
    config.selectedRpcProviders.length > 0
      ? config.selectedRpcProviders.join(", ")
      : "default";

  return (
    <Card title="Wallet" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="subheading" grow={1}>
          {formatUsd(portfolioValueUsd)}
        </Text>
        <Text style="caption" tone="muted">
          {snapshot.loading ? "loading" : `${tokenRows.length} tokens`}
        </Text>
      </HStack>

      <HStack gap={1} align="center">
        <Text
          style="caption"
          tone={config.evmBalanceReady ? "success" : "muted"}
        >
          {config.evmBalanceReady ? "evm-ready" : "evm-off"}
        </Text>
        <Text
          style="caption"
          tone={config.solanaBalanceReady ? "success" : "muted"}
          grow={1}
        >
          {config.solanaBalanceReady ? "sol-ready" : "sol-off"}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          {rpc}
        </Text>
      </HStack>

      {snapshot.error ? (
        <Text tone="danger" style="caption">
          {snapshot.error}
        </Text>
      ) : null}

      <HStack gap={1} wrap>
        {TAB_KEYS.map((tab) => (
          <Button
            key={tab}
            variant="outline"
            tone="default"
            grow={1}
            agent={`tab-${tab}`}
            onPress={dispatch(`tab:${tab}`)}
          >
            {tab}
          </Button>
        ))}
        <Button agent="refresh" onPress={dispatch("refresh")}>
          Refresh
        </Button>
      </HStack>

      <Divider label="tokens" />
      {tokenRows.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No tokens
        </Text>
      ) : (
        <List gap={0}>
          {tokenRows.slice(0, 8).map((token) => (
            <HStack
              key={token.id}
              gap={1}
              align="center"
              agent={`token-${token.id}`}
            >
              <Text bold wrap={false}>
                {token.symbol}
              </Text>
              <Text style="caption" tone="muted" grow={1} wrap={false}>
                {token.chain}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                {token.balance}
              </Text>
              <Text wrap={false}>{formatUsd(token.valueUsd)}</Text>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="movers" />
      {marketMovers.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No market data
        </Text>
      ) : (
        <List gap={0}>
          {marketMovers.slice(0, 5).map((mover) => (
            <HStack key={mover.id} gap={1} align="center">
              <Text bold grow={1} wrap={false}>
                {mover.symbol}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                {formatUsd(mover.priceUsd)}
              </Text>
              <Text tone={changeTone(mover.change24hPct)} wrap={false}>
                {changeMark(mover.change24hPct)}
                {Math.abs(mover.change24hPct).toFixed(1)}%
              </Text>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="pnl" />
      <HStack gap={1} align="center">
        <Text grow={1}>Realized P&amp;L</Text>
        <Text tone={pnlTone(tradingProfile.realizedPnlBnb)} wrap={false}>
          {tradingProfile.realizedPnlBnb >= 0 ? "+" : ""}
          {tradingProfile.realizedPnlBnb.toFixed(4)} BNB
        </Text>
      </HStack>
      {tradingProfile.recentSwaps.length > 0 ? (
        <List gap={0}>
          {tradingProfile.recentSwaps.slice(0, 4).map((swap) => (
            <HStack key={swap.id} gap={1} align="center">
              <Text grow={1} wrap={false}>
                {swap.pair}
              </Text>
              <Text style="caption" tone="muted" wrap={false}>
                {swap.when}
              </Text>
            </HStack>
          ))}
        </List>
      ) : null}

      <Divider label="nfts" />
      {walletNfts.length === 0 ? (
        <Text tone="muted" align="center" style="caption">
          No NFTs
        </Text>
      ) : (
        <List gap={0}>
          {walletNfts.slice(0, 6).map((nft) => (
            <HStack key={nft.id} gap={1} align="center" agent={`nft-${nft.id}`}>
              <Text tone="primary" wrap={false}>
                #
              </Text>
              <VStack gap={0} grow={1}>
                <Text bold wrap={false}>
                  {nft.name}
                </Text>
                <Text style="caption" tone="muted" wrap={false}>
                  {nft.collectionName}
                </Text>
              </VStack>
              <Text style="caption" tone="muted" wrap={false}>
                {nft.chain}
              </Text>
            </HStack>
          ))}
        </List>
      )}

      <Divider label="addresses" />
      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1} wrap={false}>
          EVM {shortAddress(addresses.evmAddress)}
        </Text>
        <Text style="caption" tone="muted" wrap={false}>
          SOL {shortAddress(addresses.solanaAddress)}
        </Text>
      </HStack>
    </Card>
  );
}
