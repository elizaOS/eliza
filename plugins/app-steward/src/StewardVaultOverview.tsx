import type {
  StewardBalanceResponse,
  StewardStatusResponse,
  StewardTokenBalancesResponse,
  StewardWalletAddressesResponse,
  StewardWebhookEvent,
  StewardWebhookEventsResponse,
  StewardWebhookEventType,
} from "@elizaai/shared/contracts/wallet";
import { Button } from "@elizaos/ui";
import { Copy, RefreshCw, Shield } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getChainName, truncateAddress } from "./chain-utils";

interface StewardVaultOverviewProps {
  stewardStatus: StewardStatusResponse;
  getStewardAddresses: () => Promise<StewardWalletAddressesResponse>;
  getStewardBalance: (chainId?: number) => Promise<StewardBalanceResponse>;
  getStewardTokens: (chainId?: number) => Promise<StewardTokenBalancesResponse>;
  getStewardWebhookEvents: (opts?: {
    event?: StewardWebhookEventType;
    since?: number;
  }) => Promise<StewardWebhookEventsResponse>;
  copyToClipboard: (text: string) => Promise<void>;
  setActionNotice: (
    text: string,
    tone?: "info" | "success" | "error",
    ttlMs?: number,
  ) => void;
}

interface ChainSnapshot {
  chainId: number;
  label: string;
  address: string;
  balance: string | null;
  tokenCount: number;
  tokenSymbols: string[];
  error: string | null;
}

const OVERVIEW_CHAINS = [
  { label: "Ethereum", chainId: 1, addressKey: "evmAddress" as const },
  { label: "BSC", chainId: 56, addressKey: "evmAddress" as const },
  { label: "Base", chainId: 8453, addressKey: "evmAddress" as const },
  { label: "Solana", chainId: 101, addressKey: "solanaAddress" as const },
] as const;

function formatVaultHealth(status: StewardStatusResponse): string {
  if (status.vaultHealth === "degraded") return "Vault healthy enough to use";
  if (status.vaultHealth === "error") return "Vault needs attention";
  return "Vault connected and ready";
}

function formatEventLabel(event: StewardWebhookEventType): string {
  switch (event) {
    case "tx.pending":
      return "Pending approval";
    case "tx.approved":
      return "Approved";
    case "tx.denied":
      return "Denied";
    case "tx.confirmed":
      return "Confirmed";
    default:
      return event;
  }
}

function formatEventTime(timestamp?: string): string {
  if (!timestamp) return "Unknown time";
  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) return timestamp;
  return parsed.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function extractEventReference(event: StewardWebhookEvent): string | null {
  const txHash =
    typeof event.data.txHash === "string" ? event.data.txHash.trim() : "";
  if (txHash) return `Tx ${truncateAddress(txHash, 4)}`;

  const txId =
    typeof event.data.txId === "string" ? event.data.txId.trim() : "";
  if (txId) return `Request ${truncateAddress(txId, 4)}`;

  const queueId =
    typeof event.data.queueId === "string" ? event.data.queueId.trim() : "";
  if (queueId) return `Queue ${truncateAddress(queueId, 4)}`;

  const chainId =
    typeof event.data.chainId === "number"
      ? event.data.chainId
      : Number(event.data.chainId);
  if (Number.isFinite(chainId) && chainId > 0) {
    return getChainName(chainId);
  }

  return null;
}

function formatChainErrorMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (/rpc method is unsupported/i.test(message)) {
    return "Chain RPC is temporarily unavailable.";
  }
  if (/429|Too many connections/i.test(message)) {
    return "Chain RPC is temporarily rate-limited.";
  }
  if (/403 Forbidden/i.test(message)) {
    return "Chain RPC rejected the request.";
  }
  return message || "Chain data unavailable.";
}

export function StewardVaultOverview({
  stewardStatus,
  getStewardAddresses,
  getStewardBalance,
  getStewardTokens,
  getStewardWebhookEvents,
  copyToClipboard,
  setActionNotice,
}: StewardVaultOverviewProps) {
  const [addresses, setAddresses] = useState<StewardWalletAddressesResponse>({
    evmAddress:
      stewardStatus.walletAddresses?.evm ?? stewardStatus.evmAddress ?? null,
    solanaAddress: stewardStatus.walletAddresses?.solana ?? null,
  });
  const [chainSnapshots, setChainSnapshots] = useState<ChainSnapshot[]>([]);
  const [events, setEvents] = useState<StewardWebhookEvent[]>([]);
  const [eventsError, setEventsError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadOverview = useCallback(async () => {
    setRefreshing(true);
    setError(null);

    const fallbackAddresses: StewardWalletAddressesResponse = {
      evmAddress:
        stewardStatus.walletAddresses?.evm ?? stewardStatus.evmAddress ?? null,
      solanaAddress: stewardStatus.walletAddresses?.solana ?? null,
    };

    const [addressesResult, eventsResult] = await Promise.allSettled([
      getStewardAddresses(),
      getStewardWebhookEvents(),
    ]);

    const resolvedAddresses =
      addressesResult.status === "fulfilled"
        ? addressesResult.value
        : fallbackAddresses;

    setAddresses(resolvedAddresses);

    if (eventsResult.status === "fulfilled") {
      const orderedEvents = [...(eventsResult.value.events ?? [])].sort(
        (a, b) => {
          const aTime = new Date(a.timestamp ?? 0).getTime();
          const bTime = new Date(b.timestamp ?? 0).getTime();
          return bTime - aTime;
        },
      );
      setEvents(orderedEvents.slice(0, 6));
      setEventsError(null);
    } else {
      setEvents([]);
      setEventsError(
        formatChainErrorMessage(eventsResult.reason) ||
          "Failed to load recent vault events",
      );
    }

    const enabledChains = OVERVIEW_CHAINS.filter(
      (chain) => resolvedAddresses[chain.addressKey],
    );

    const snapshots = await Promise.all(
      enabledChains.map(async (chain): Promise<ChainSnapshot> => {
        const chainAddress = resolvedAddresses[chain.addressKey];
        if (!chainAddress) {
          return {
            chainId: chain.chainId,
            label: chain.label,
            address: "",
            balance: null,
            tokenCount: 0,
            tokenSymbols: [],
            error: "Wallet address unavailable",
          };
        }

        const [balanceResult, tokensResult] = await Promise.allSettled([
          getStewardBalance(chain.chainId),
          getStewardTokens(chain.chainId),
        ]);

        if (
          balanceResult.status === "rejected" &&
          tokensResult.status === "rejected"
        ) {
          const balanceMessage = formatChainErrorMessage(balanceResult.reason);
          return {
            chainId: chain.chainId,
            label: chain.label,
            address: chainAddress,
            balance: null,
            tokenCount: 0,
            tokenSymbols: [],
            error: balanceMessage,
          };
        }

        const tokens =
          tokensResult.status === "fulfilled" ? tokensResult.value.tokens : [];
        return {
          chainId: chain.chainId,
          label: chain.label,
          address: chainAddress,
          balance:
            balanceResult.status === "fulfilled"
              ? balanceResult.value.formatted
              : tokensResult.status === "fulfilled"
                ? tokensResult.value.native.formatted
                : null,
          tokenCount: tokens.length,
          tokenSymbols: tokens
            .map((token) => token.symbol.trim())
            .filter(Boolean)
            .slice(0, 3),
          error:
            balanceResult.status === "rejected"
              ? formatChainErrorMessage(balanceResult.reason)
              : tokensResult.status === "rejected"
                ? formatChainErrorMessage(tokensResult.reason)
                : null,
        };
      }),
    );

    setChainSnapshots(snapshots);

    if (addressesResult.status === "rejected" && snapshots.length === 0) {
      setError(
        addressesResult.reason instanceof Error
          ? addressesResult.reason.message
          : "Failed to load Steward vault details",
      );
    }

    setLoading(false);
    setRefreshing(false);
  }, [
    getStewardAddresses,
    getStewardBalance,
    getStewardTokens,
    getStewardWebhookEvents,
    stewardStatus.evmAddress,
    stewardStatus.walletAddresses?.evm,
    stewardStatus.walletAddresses?.solana,
  ]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview]);

  const handleCopy = useCallback(
    async (label: string, value: string) => {
      await copyToClipboard(value);
      setActionNotice(`${label} copied`, "success", 2000);
    },
    [copyToClipboard, setActionNotice],
  );

  const addressCards = useMemo(
    () =>
      [
        { label: "EVM Address", value: addresses.evmAddress },
        { label: "Solana Address", value: addresses.solanaAddress },
      ].filter((entry): entry is { label: string; value: string } =>
        Boolean(entry.value),
      ),
    [addresses.evmAddress, addresses.solanaAddress],
  );

  return (
    <div className="space-y-4" data-testid="steward-vault-overview">
      <div className="flex flex-col gap-3 rounded-3xl border border-accent/20 bg-accent/5 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="rounded-2xl border border-accent/20 bg-accent/10 p-2 text-accent">
            <Shield className="h-4 w-4" />
          </div>
          <div>
            <div className="text-sm font-semibold text-txt-strong">
              Steward vault overview
            </div>
            <div className="mt-1 text-xs text-muted">
              {formatVaultHealth(stewardStatus)}
            </div>
            {stewardStatus.agentId ? (
              <div className="mt-1 font-mono text-2xs text-muted/70">
                Agent {truncateAddress(stewardStatus.agentId, 4)}
              </div>
            ) : null}
          </div>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-9 rounded-xl px-3 text-xs font-semibold"
          onClick={() => void loadOverview()}
          disabled={refreshing}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${refreshing ? "animate-spin" : ""}`}
          />
          Refresh vault
        </Button>
      </div>

      {error ? (
        <div className="rounded-2xl border border-danger/25 bg-danger/5 px-4 py-3 text-sm text-danger">
          {error}
        </div>
      ) : null}

      <section className="space-y-3">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
          Addresses
        </div>
        {addressCards.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {addressCards.map((entry) => (
              <div
                key={entry.label}
                className="rounded-2xl border border-border/40 bg-card/60 px-4 py-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-muted">
                      {entry.label}
                    </div>
                    <div className="mt-1 break-all font-mono text-xs text-txt">
                      {entry.value}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    onClick={() => void handleCopy(entry.label, entry.value)}
                    aria-label={`Copy ${entry.label}`}
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : loading ? (
          <div className="rounded-2xl border border-border/30 bg-card/40 px-4 py-3 text-sm text-muted">
            Loading vault addresses…
          </div>
        ) : (
          <div className="rounded-2xl border border-border/30 bg-card/40 px-4 py-3 text-sm text-muted">
            No steward-managed addresses available yet.
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
          Chain readiness
        </div>
        {chainSnapshots.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {chainSnapshots.map((snapshot) => (
              <div
                key={snapshot.chainId}
                className="rounded-2xl border border-border/40 bg-card/60 px-4 py-3"
              >
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-semibold text-txt-strong">
                    {snapshot.label}
                  </div>
                  <div className="text-2xs uppercase tracking-wide text-muted">
                    {snapshot.error ? "Issue" : "Ready"}
                  </div>
                </div>
                <div className="mt-2 text-lg font-semibold text-txt-strong">
                  {snapshot.balance ?? "Unavailable"}
                </div>
                <div className="mt-1 text-xs text-muted">
                  {snapshot.tokenCount > 0
                    ? `${snapshot.tokenCount} tracked token${snapshot.tokenCount === 1 ? "" : "s"}`
                    : snapshot.error
                      ? "Token inventory unavailable"
                      : "No tracked tokens yet"}
                </div>
                {snapshot.tokenSymbols.length > 0 ? (
                  <div className="mt-2 text-2xs text-muted/80">
                    {snapshot.tokenSymbols.join(", ")}
                  </div>
                ) : null}
                {snapshot.error ? (
                  <div className="mt-2 text-2xs text-danger">
                    {snapshot.error}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        ) : loading ? (
          <div className="rounded-2xl border border-border/30 bg-card/40 px-4 py-3 text-sm text-muted">
            Loading chain balances…
          </div>
        ) : (
          <div className="rounded-2xl border border-border/30 bg-card/40 px-4 py-3 text-sm text-muted">
            No chain-level vault data is available yet.
          </div>
        )}
      </section>

      <section className="space-y-3">
        <div className="text-xs font-semibold uppercase tracking-[0.16em] text-muted">
          Recent vault events
        </div>
        {eventsError ? (
          <div className="rounded-2xl border border-border/30 bg-card/40 px-4 py-3 text-sm text-muted">
            {eventsError}
          </div>
        ) : events.length > 0 ? (
          <div className="space-y-2">
            {events.map((event, index) => {
              const reference = extractEventReference(event);
              return (
                <div
                  key={`${event.event}-${event.timestamp ?? index}`}
                  className="rounded-2xl border border-border/40 bg-card/60 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-sm font-semibold text-txt-strong">
                      {formatEventLabel(event.event)}
                    </div>
                    <div className="text-2xs text-muted">
                      {formatEventTime(event.timestamp)}
                    </div>
                  </div>
                  {reference ? (
                    <div className="mt-1 text-xs text-muted">{reference}</div>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : (
          <div className="rounded-2xl border border-border/30 bg-card/40 px-4 py-3 text-sm text-muted">
            No recent vault events yet.
          </div>
        )}
      </section>
    </div>
  );
}
