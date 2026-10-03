/**
 * The crypto terminal: live market browsing, watchlist, per-asset price
 * history, a paper order ticket, and a paper portfolio, alongside the real
 * wallet dashboard.
 *
 * Prices and history come from the plugin's read-only terminal routes and are
 * never fabricated: while they load or fail, the view says so and the order
 * ticket stays disabled. Every order here is a paper order applied to a local
 * practice ledger; the terminal never signs or submits a transaction. Real
 * balances stay in {@link InventoryAppView}, which owns the wallet pipeline.
 */
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  SegmentedControl,
} from "@elizaos/ui";
import { Escape } from "@elizaos/ui/spatial";
import { cn } from "@elizaos/ui/utils";
import { ArrowLeft, Search, Star } from "lucide-react";
import * as React from "react";
import { useId, useMemo, useState } from "react";
import type {
  WalletTerminalChartDays,
  WalletTerminalMarket,
  WalletTerminalMarketsResponse,
} from "../contracts.ts";
import { InventoryAppView } from "./components/InventoryAppView.tsx";
import {
  formatTerminalChange,
  formatTerminalUnits,
  formatTerminalUsd,
} from "./terminal/format.ts";
import { PriceChart } from "./terminal/PriceChart.tsx";
import {
  availableCashUsd,
  availableUnits,
  cancelPaperOrder,
  PAPER_STARTING_CASH_USD,
  type PaperOrderInput,
  type PaperOrderRejection,
  type PaperOrderSide,
  type PaperOrderType,
  placePaperOrder,
  previewPaperOrder,
  valuePaperLedger,
} from "./terminal/paper-ledger.ts";
import {
  type PaperLedgerState,
  type RemoteState,
  usePaperLedger,
  useTerminalChart,
  useTerminalMarkets,
  useWatchlist,
} from "./terminal/terminal-data.ts";

void React;

type TerminalSection = "markets" | "watchlist" | "portfolio" | "wallet";

const SECTIONS: Array<{ value: TerminalSection; label: string }> = [
  { value: "markets", label: "Markets" },
  { value: "watchlist", label: "Watchlist" },
  { value: "portfolio", label: "Paper portfolio" },
  { value: "wallet", label: "Wallet" },
];

const PERIODS: Array<{ value: `${WalletTerminalChartDays}`; label: string }> = [
  { value: "1", label: "1D" },
  { value: "7", label: "1W" },
  { value: "30", label: "1M" },
  { value: "90", label: "3M" },
  { value: "365", label: "1Y" },
];

const REJECTION_COPY: Record<PaperOrderRejection, string> = {
  "invalid-amount": "Enter an amount greater than zero.",
  "invalid-price": "Enter a limit price greater than zero.",
  "insufficient-cash": "Amount exceeds available paper cash.",
  "insufficient-units": "Amount exceeds available paper holdings.",
  "too-small": "Amount is too small at this price.",
};

function changeTone(pct: number): string {
  return pct >= 0 ? "text-ok" : "text-danger";
}

function AssetMark({ market }: { market: WalletTerminalMarket }) {
  const [imageFailed, setImageFailed] = useState(false);
  return market.imageUrl && !imageFailed ? (
    <img
      src={market.imageUrl}
      alt=""
      className="size-8 shrink-0 rounded-full"
      loading="lazy"
      onError={() => setImageFailed(true)}
    />
  ) : (
    <span
      aria-hidden="true"
      className="grid size-8 shrink-0 place-items-center rounded-full bg-surface text-[0.6rem] font-semibold text-txt"
    >
      {market.symbol.slice(0, 4)}
    </span>
  );
}

function MarketStatus({
  state,
}: {
  state: RemoteState<WalletTerminalMarketsResponse>;
}) {
  if (state.status !== "ready") return null;
  const { data, refreshError } = state;
  const stale = data.stale || refreshError !== null;
  return (
    <p
      className={cn("text-xs", stale ? "text-warn" : "text-muted")}
      data-testid="terminal-market-status"
    >
      {stale
        ? `Prices may be outdated — last updated ${new Date(data.generatedAt).toLocaleTimeString()}`
        : `Live prices from ${data.source.providerName} · ${new Date(data.generatedAt).toLocaleTimeString()}`}
    </p>
  );
}

function MarketList({
  markets,
  watchlist,
  onToggleWatch,
  onOpen,
  watchOnly,
}: {
  markets: WalletTerminalMarket[];
  watchlist: ReadonlySet<string>;
  onToggleWatch: (id: string) => void;
  onOpen: (id: string) => void;
  watchOnly: boolean;
}) {
  const [query, setQuery] = useState("");
  const searchId = useId();
  const needle = query.trim().toLowerCase();
  const rows = markets.filter(
    (market) =>
      (!watchOnly || watchlist.has(market.id)) &&
      (needle === "" ||
        market.name.toLowerCase().includes(needle) ||
        market.symbol.toLowerCase().includes(needle)),
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search markets
        </label>
        <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted" />
        <Input
          id={searchId}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search by name or symbol"
          className="pl-9"
          data-testid="terminal-market-search"
        />
      </div>
      {rows.length === 0 ? (
        <p className="rounded-md border border-border/70 px-4 py-8 text-center text-sm text-muted">
          {watchOnly && needle === ""
            ? "Your watchlist is empty. Star an asset in Markets to follow it here."
            : "No assets match your search."}
        </p>
      ) : (
        <ul className="divide-y divide-border/70 rounded-md border border-border/70">
          {rows.map((market) => {
            const watched = watchlist.has(market.id);
            return (
              <li key={market.id} className="flex items-center gap-2 pr-2">
                <button
                  type="button"
                  onClick={() => onOpen(market.id)}
                  className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left hover:bg-bg-hover"
                  data-testid={`terminal-market-row-${market.id}`}
                >
                  <AssetMark market={market} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-medium text-txt">
                      {market.name}
                    </span>
                    <span className="text-xs text-muted">
                      {market.symbol}
                      {market.marketCapRank !== null
                        ? ` · #${market.marketCapRank}`
                        : ""}
                    </span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm font-medium text-txt">
                      {formatTerminalUsd(market.priceUsd)}
                    </span>
                    <span
                      className={cn("text-xs", changeTone(market.change24hPct))}
                    >
                      {formatTerminalChange(market.change24hPct)}
                    </span>
                  </span>
                </button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-pressed={watched}
                  aria-label={
                    watched
                      ? `Remove ${market.name} from watchlist`
                      : `Add ${market.name} to watchlist`
                  }
                  onClick={() => onToggleWatch(market.id)}
                >
                  <Star
                    className={cn(
                      "size-4",
                      watched && "fill-accent text-accent",
                    )}
                  />
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function OrderTicket({
  market,
  paper,
}: {
  market: WalletTerminalMarket;
  paper: PaperLedgerState;
}) {
  const [side, setSide] = useState<PaperOrderSide>("buy");
  const [type, setType] = useState<PaperOrderType>("market");
  const [amount, setAmount] = useState("");
  const [limit, setLimit] = useState("");
  const [reviewing, setReviewing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const amountId = useId();
  const limitId = useId();

  const input: PaperOrderInput = {
    asset: { id: market.id, symbol: market.symbol, priceUsd: market.priceUsd },
    side,
    type,
    amount: Number(amount),
    ...(type === "limit" ? { limitPriceUsd: Number(limit) } : {}),
  };
  const preview = previewPaperOrder(paper.ledger, input);
  const available =
    side === "buy"
      ? formatTerminalUsd(availableCashUsd(paper.ledger))
      : `${formatTerminalUnits(availableUnits(paper.ledger, market.id))} ${market.symbol}`;
  const touched = amount !== "" || (type === "limit" && limit !== "");

  const place = () => {
    const result = placePaperOrder(
      paper.ledger,
      input,
      `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      Date.now(),
    );
    paper.update(result.ledger);
    setReviewing(false);
    setAmount("");
    setLimit("");
    setNotice(
      result.order.status === "filled"
        ? `Paper ${side} filled: ${formatTerminalUnits(result.order.units)} ${market.symbol} at ${formatTerminalUsd(result.order.priceUsd)}.`
        : `Paper limit ${side} queued at ${formatTerminalUsd(result.order.priceUsd)}. It fills when the live price crosses it.`,
    );
  };

  return (
    <section
      aria-labelledby="paper-ticket-title"
      className="flex flex-col gap-3 rounded-md border border-border/70 p-4"
    >
      <div className="flex items-center justify-between gap-2">
        <h2 id="paper-ticket-title" className="text-sm font-semibold text-txt">
          Paper order
        </h2>
        <span className="rounded-full bg-accent-subtle px-2 py-0.5 text-[0.68rem] font-medium uppercase tracking-wide text-txt">
          Simulation
        </span>
      </div>
      <SegmentedControl
        value={side}
        onValueChange={setSide}
        items={[
          { value: "buy", label: "Buy" },
          { value: "sell", label: "Sell" },
        ]}
        aria-label="Order side"
      />
      <SegmentedControl
        value={type}
        onValueChange={(next) => {
          setType(next);
          setLimit("");
        }}
        items={[
          { value: "market", label: "Market" },
          { value: "limit", label: "Limit" },
        ]}
        aria-label="Order type"
      />
      <div className="flex flex-col gap-1 text-xs text-muted">
        <label htmlFor={amountId}>
          {side === "buy" ? "Amount (USD)" : `Amount (${market.symbol})`}
        </label>
        <Input
          id={amountId}
          inputMode="decimal"
          value={amount}
          onChange={(event) => setAmount(event.target.value)}
          placeholder="0.00"
          data-testid="paper-order-amount"
        />
      </div>
      {type === "limit" ? (
        <div className="flex flex-col gap-1 text-xs text-muted">
          <label htmlFor={limitId}>Limit price (USD)</label>
          <Input
            id={limitId}
            inputMode="decimal"
            value={limit}
            onChange={(event) => setLimit(event.target.value)}
            placeholder={market.priceUsd.toString()}
            data-testid="paper-order-limit"
          />
        </div>
      ) : null}
      <dl className="grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-muted">Available</dt>
        <dd className="text-right text-txt">{available}</dd>
        <dt className="text-muted">
          {type === "limit" ? "Limit price" : "Live price"}
        </dt>
        <dd className="text-right text-txt">
          {preview.ok
            ? formatTerminalUsd(preview.priceUsd)
            : formatTerminalUsd(market.priceUsd)}
        </dd>
        {preview.ok ? (
          <>
            <dt className="text-muted">Quantity</dt>
            <dd className="text-right text-txt">
              {formatTerminalUnits(preview.units)} {market.symbol}
            </dd>
            <dt className="text-muted">
              {side === "buy" ? "Paper cost" : "Paper proceeds"}
            </dt>
            <dd className="text-right text-txt">
              {formatTerminalUsd(preview.notionalUsd)}
            </dd>
          </>
        ) : null}
      </dl>
      {touched && !preview.ok ? (
        <p className="text-xs text-danger" role="alert">
          {REJECTION_COPY[preview.reason]}
        </p>
      ) : null}
      <Button
        disabled={!preview.ok}
        onClick={() => setReviewing(true)}
        data-testid="paper-order-review"
      >
        Review paper {side}
      </Button>
      {notice ? (
        <p className="text-xs text-txt" role="status">
          {notice}
        </p>
      ) : null}
      <Dialog open={reviewing} onOpenChange={setReviewing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Review paper {side} · {market.symbol}
            </DialogTitle>
            <DialogDescription>
              {type === "limit"
                ? "This limit order reserves paper funds and fills when the live price crosses your limit."
                : "This market order fills at the current live price."}{" "}
              Only your local practice balance changes. No wallet is used and no
              real trade is sent.
            </DialogDescription>
          </DialogHeader>
          {preview.ok ? (
            <dl className="grid grid-cols-2 gap-y-1.5 text-sm">
              <dt className="text-muted">Order</dt>
              <dd className="text-right">
                {side.toUpperCase()} · {type.toUpperCase()}
              </dd>
              <dt className="text-muted">Price</dt>
              <dd className="text-right">
                {formatTerminalUsd(preview.priceUsd)}
              </dd>
              <dt className="text-muted">Quantity</dt>
              <dd className="text-right">
                {formatTerminalUnits(preview.units)} {market.symbol}
              </dd>
              <dt className="text-muted">
                {side === "buy" ? "Paper cost" : "Paper proceeds"}
              </dt>
              <dd className="text-right">
                {formatTerminalUsd(preview.notionalUsd)}
              </dd>
            </dl>
          ) : (
            <p className="text-sm text-danger">
              {REJECTION_COPY[preview.reason]}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setReviewing(false)}>
              Cancel
            </Button>
            <Button
              disabled={!preview.ok}
              onClick={place}
              data-testid="paper-order-place"
            >
              Place paper order
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function AssetDetail({
  market,
  watched,
  onToggleWatch,
  onBack,
  paper,
}: {
  market: WalletTerminalMarket;
  watched: boolean;
  onToggleWatch: () => void;
  onBack: () => void;
  paper: PaperLedgerState;
}) {
  const [period, setPeriod] = useState<`${WalletTerminalChartDays}`>("7");
  const chart = useTerminalChart(
    market.id,
    Number(period) as WalletTerminalChartDays,
  );

  return (
    <div className="flex flex-col gap-4">
      <Button variant="ghost" size="sm" className="self-start" onClick={onBack}>
        <ArrowLeft className="size-4" /> Back to markets
      </Button>
      <div className="flex flex-wrap items-center gap-3">
        <AssetMark market={market} />
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-semibold text-txt">
            {market.name}{" "}
            <span className="text-sm font-normal text-muted">
              {market.symbol}
            </span>
          </h2>
          <p className="text-sm">
            <span className="font-medium text-txt">
              {formatTerminalUsd(market.priceUsd)}
            </span>{" "}
            <span className={changeTone(market.change24hPct)}>
              {formatTerminalChange(market.change24hPct)} 24h
            </span>
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          aria-pressed={watched}
          onClick={onToggleWatch}
        >
          <Star
            className={cn("size-4", watched && "fill-accent text-accent")}
          />
          {watched ? "Watching" : "Watch"}
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <section className="flex flex-col gap-3 rounded-md border border-border/70 p-4">
          <SegmentedControl
            value={period}
            onValueChange={setPeriod}
            items={PERIODS}
            aria-label="Chart period"
          />
          {chart.status === "loading" ? (
            <div
              className="h-56 animate-pulse rounded-md bg-surface"
              role="status"
              aria-label="Loading price history"
            />
          ) : chart.status === "error" ? (
            <p className="grid h-56 place-items-center text-sm text-muted">
              Price history unavailable: {chart.message}
            </p>
          ) : (
            <PriceChart points={chart.data.points} label={market.name} />
          )}
        </section>
        <OrderTicket key={market.id} market={market} paper={paper} />
      </div>
    </div>
  );
}

function PaperPortfolio({
  paper,
  prices,
  marketsById,
  onOpen,
}: {
  paper: PaperLedgerState;
  prices: ReadonlyMap<string, number>;
  marketsById: ReadonlyMap<string, WalletTerminalMarket>;
  onOpen: (id: string) => void;
}) {
  const valuation = valuePaperLedger(paper.ledger, prices);
  const [confirmReset, setConfirmReset] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      {paper.loadError ? (
        <p
          role="alert"
          className="rounded-md border border-warn/40 bg-warn/10 px-3 py-2 text-sm text-txt"
        >
          {paper.loadError}. A fresh practice portfolio was started; your next
          paper order replaces the unreadable one.
        </p>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-md border border-border/70 p-4">
          <p className="text-xs uppercase tracking-wide text-muted">
            Total paper value
          </p>
          <p
            className="mt-1 text-2xl font-semibold text-txt"
            data-testid="paper-total"
          >
            {valuation.totalUsd === null
              ? "Unavailable"
              : formatTerminalUsd(valuation.totalUsd)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {valuation.totalUsd === null
              ? "Waiting for live prices for every holding."
              : "Valued at live market prices."}
          </p>
        </div>
        <div className="rounded-md border border-border/70 p-4">
          <p className="text-xs uppercase tracking-wide text-muted">
            Paper cash
          </p>
          <p className="mt-1 text-2xl font-semibold text-txt">
            {formatTerminalUsd(valuation.cashUsd)}
          </p>
          <p className="mt-1 text-xs text-muted">
            {formatTerminalUsd(availableCashUsd(paper.ledger))} available ·
            started at {formatTerminalUsd(PAPER_STARTING_CASH_USD)}
          </p>
        </div>
      </div>
      <section aria-labelledby="paper-holdings-title">
        <h2
          id="paper-holdings-title"
          className="mb-2 text-sm font-semibold text-txt"
        >
          Holdings
        </h2>
        {valuation.positions.length === 0 ? (
          <p className="rounded-md border border-border/70 px-4 py-6 text-center text-sm text-muted">
            No paper holdings yet. Open an asset in Markets to place a paper
            buy.
          </p>
        ) : (
          <ul className="divide-y divide-border/70 rounded-md border border-border/70">
            {valuation.positions.map((position) => {
              const market = marketsById.get(position.assetId);
              return (
                <li key={position.assetId}>
                  <button
                    type="button"
                    disabled={!market}
                    onClick={() => onOpen(position.assetId)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-bg-hover disabled:hover:bg-transparent"
                  >
                    <span>
                      <span className="block text-sm font-medium text-txt">
                        {market?.name ?? position.symbol}
                      </span>
                      <span className="text-xs text-muted">
                        {formatTerminalUnits(position.units)} {position.symbol}
                      </span>
                    </span>
                    <span className="text-right text-sm text-txt">
                      {position.valueUsd === null
                        ? "Price unavailable"
                        : formatTerminalUsd(position.valueUsd)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
      <section aria-labelledby="paper-activity-title">
        <h2
          id="paper-activity-title"
          className="mb-2 text-sm font-semibold text-txt"
        >
          Paper activity
        </h2>
        {paper.ledger.orders.length === 0 ? (
          <p className="rounded-md border border-border/70 px-4 py-6 text-center text-sm text-muted">
            No paper orders yet.
          </p>
        ) : (
          <ul
            className="divide-y divide-border/70 rounded-md border border-border/70"
            data-testid="paper-activity"
          >
            {paper.ledger.orders.map((order) => (
              <li
                key={order.id}
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <span>
                  <span className="block text-sm font-medium text-txt">
                    {order.side === "buy" ? "Buy" : "Sell"}{" "}
                    {formatTerminalUnits(order.units)} {order.symbol}
                  </span>
                  <span className="text-xs text-muted">
                    {order.type === "limit" ? "Limit" : "Market"} at{" "}
                    {formatTerminalUsd(order.priceUsd)} ·{" "}
                    {new Date(order.createdAt).toLocaleString()}
                  </span>
                </span>
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "rounded-full px-2 py-0.5 text-[0.68rem] font-medium uppercase",
                      order.status === "open"
                        ? "bg-accent-subtle text-txt"
                        : order.status === "filled"
                          ? "bg-ok/10 text-ok"
                          : "bg-surface text-muted",
                    )}
                  >
                    {order.status}
                  </span>
                  {order.status === "open" ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() =>
                        paper.update(
                          cancelPaperOrder(paper.ledger, order.id, Date.now()),
                        )
                      }
                    >
                      Cancel
                    </Button>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={() => setConfirmReset(true)}
      >
        Reset paper portfolio
      </Button>
      <Dialog open={confirmReset} onOpenChange={setConfirmReset}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Reset paper portfolio?</DialogTitle>
            <DialogDescription>
              This clears paper holdings and order history and restores{" "}
              {formatTerminalUsd(PAPER_STARTING_CASH_USD)} of paper cash. Your
              real wallet is not affected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmReset(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                paper.reset();
                setConfirmReset(false);
              }}
            >
              Reset
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function CryptoTerminalView() {
  const [section, setSection] = useState<TerminalSection>("markets");
  const [assetId, setAssetId] = useState<string | null>(null);
  const marketsState = useTerminalMarkets();
  const watchlist = useWatchlist();
  const markets =
    marketsState.status === "ready" ? marketsState.data.markets : null;
  const marketsById = useMemo(
    () => new Map((markets ?? []).map((market) => [market.id, market])),
    [markets],
  );
  const prices = useMemo(
    () =>
      markets
        ? new Map(markets.map((market) => [market.id, market.priceUsd]))
        : null,
    [markets],
  );
  const paper = usePaperLedger(prices);
  const selected = assetId ? marketsById.get(assetId) : undefined;

  const open = (id: string) => {
    setAssetId(id);
    if (section === "wallet") setSection("markets");
  };

  let body: React.ReactNode;
  if (section === "wallet") {
    body = <InventoryAppView />;
  } else if (marketsState.status === "loading") {
    body = (
      <p role="status" className="px-1 py-8 text-center text-sm text-muted">
        Loading live markets…
      </p>
    );
  } else if (marketsState.status === "error" && section !== "portfolio") {
    body = (
      <p
        role="alert"
        className="rounded-md border border-border/70 px-4 py-8 text-center text-sm text-muted"
      >
        Live market data is unavailable ({marketsState.message}). Paper trading
        is paused until prices load.
      </p>
    );
  } else if (selected && section !== "portfolio") {
    body = (
      <AssetDetail
        market={selected}
        watched={watchlist.ids.has(selected.id)}
        onToggleWatch={() => watchlist.toggle(selected.id)}
        onBack={() => setAssetId(null)}
        paper={paper}
      />
    );
  } else if (section === "portfolio") {
    body = (
      <PaperPortfolio
        paper={paper}
        prices={prices ?? new Map()}
        marketsById={marketsById}
        onOpen={(id) => {
          setSection("markets");
          setAssetId(id);
        }}
      />
    );
  } else {
    body = (
      <MarketList
        key={section}
        markets={markets ?? []}
        watchlist={watchlist.ids}
        onToggleWatch={watchlist.toggle}
        onOpen={open}
        watchOnly={section === "watchlist"}
      />
    );
  }

  return (
    <Escape>
      <div className="flex min-h-full w-full flex-col bg-bg">
        <header className="flex flex-col gap-3 border-border border-b px-4 py-3 md:px-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold text-txt">
                Crypto Terminal
              </h1>
              <p className="text-xs text-muted">
                Live markets with paper trading. Orders here never touch your
                wallet.
              </p>
            </div>
            <span className="rounded-full border border-border px-2.5 py-1 text-[0.68rem] font-medium uppercase tracking-[0.12em] text-muted">
              Paper trading
            </span>
          </div>
          <SegmentedControl
            role="tablist"
            value={section}
            onValueChange={(next) => {
              setSection(next);
              setAssetId(null);
            }}
            items={SECTIONS}
            aria-label="Terminal sections"
            className="max-w-full overflow-x-auto"
          />
          {section !== "wallet" ? <MarketStatus state={marketsState} /> : null}
        </header>
        <div
          className={cn(
            "min-h-0 flex-1",
            section !== "wallet" && "px-4 py-4 md:px-6",
          )}
        >
          {body}
        </div>
      </div>
    </Escape>
  );
}
