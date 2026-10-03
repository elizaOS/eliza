/**
 * The crypto terminal: live market browsing, watchlist, per-asset price
 * history, a paper order ticket, a paper portfolio, price alerts, a Solana
 * token safety check, and the HUNT / SLEEP / OFF operating mode, alongside the
 * real wallet dashboard.
 *
 * Prices and history come from the plugin's read-only terminal routes and are
 * never fabricated: while they load or fail, the view says so and the order
 * ticket stays disabled. Every order here is a paper order applied to a local
 * practice ledger; the terminal never signs or submits a transaction, in any
 * mode. A mode changes only after the user confirms it, and OFF stops every
 * automatic market request. Real
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
import {
  ArrowLeft,
  Bell,
  RefreshCw,
  Search,
  ShieldCheck,
  Star,
  X,
} from "lucide-react";
import * as React from "react";
import { useId, useMemo, useState } from "react";
import type {
  WalletTerminalChartDays,
  WalletTerminalMarket,
  WalletTokenSafetySeverity,
  WalletTokenSafetyVerdict,
} from "../contracts.ts";
import { InventoryAppView } from "./components/InventoryAppView.tsx";
import {
  formatTerminalChange,
  formatTerminalUnits,
  formatTerminalUsd,
} from "./terminal/format.ts";
import {
  OPERATING_MODES,
  type OperatingModeChange,
  pollsMarkets,
  rankScoutCandidates,
  type TerminalOperatingMode,
} from "./terminal/operating-mode.ts";
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
  alertsActive,
  type PriceAlert,
  type PriceAlertDirection,
  type PriceAlertRejection,
} from "./terminal/price-alerts.ts";
import {
  type PaperLedgerState,
  type PriceAlertsHandle,
  type TerminalMarketsState,
  useOperatingMode,
  usePaperLedger,
  usePriceAlerts,
  useTerminalChart,
  useTerminalMarkets,
  useTokenSafety,
  useWatchlist,
} from "./terminal/terminal-data.ts";

void React;

type TerminalSection =
  | "markets"
  | "watchlist"
  | "portfolio"
  | "safety"
  | "wallet";

const SECTIONS: Array<{ value: TerminalSection; label: string }> = [
  { value: "markets", label: "Markets" },
  { value: "watchlist", label: "Watchlist" },
  { value: "portfolio", label: "Paper portfolio" },
  { value: "safety", label: "Token safety" },
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
  mode,
  onRefresh,
}: {
  state: TerminalMarketsState;
  mode: TerminalOperatingMode;
  onRefresh: () => void;
}) {
  const off = mode === "off";
  let text: string | null = null;
  let warn = false;
  if (state.status === "ready") {
    const { data, refreshError } = state;
    const updated = new Date(data.generatedAt).toLocaleTimeString();
    warn = data.stale || refreshError !== null;
    text = warn
      ? `Prices may be outdated — last updated ${updated}`
      : off
        ? `Prices from ${data.source.providerName} as of ${updated} · automatic updates are off`
        : `Live prices from ${data.source.providerName} · ${updated}`;
  } else if (off && state.status === "idle") {
    text = "Terminal is off. Automatic price updates are stopped.";
  }
  if (text === null && !off) return null;
  return (
    <div className="flex flex-wrap items-center gap-2">
      {text !== null ? (
        <p
          className={cn("text-xs", warn ? "text-warn" : "text-muted")}
          data-testid="terminal-market-status"
        >
          {text}
        </p>
      ) : null}
      {off ? (
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={state.status === "loading"}
          data-testid="terminal-refresh-prices"
        >
          <RefreshCw className="size-3.5" /> Refresh prices
        </Button>
      ) : null}
    </div>
  );
}

const MODE_LABEL: Record<TerminalOperatingMode, string> = {
  hunt: "HUNT",
  sleep: "SLEEP",
  off: "OFF",
};

function ModeControl({
  mode,
  history,
  loadError,
  onChange,
}: {
  mode: TerminalOperatingMode;
  history: OperatingModeChange[];
  loadError: string | null;
  onChange: (to: TerminalOperatingMode) => void;
}) {
  const [pending, setPending] = useState<TerminalOperatingMode | null>(null);
  const pendingInfo = OPERATING_MODES.find((entry) => entry.value === pending);
  const since = history[0];
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.68rem] font-medium uppercase tracking-[0.12em] text-muted">
          Mode
        </span>
        <SegmentedControl
          value={mode}
          onValueChange={(next) => {
            if (next !== mode) setPending(next);
          }}
          items={OPERATING_MODES.map((entry) => ({
            value: entry.value,
            label: entry.label,
          }))}
          aria-label="Operating mode"
        />
        <span className="text-xs text-muted" data-testid="terminal-mode-status">
          {MODE_LABEL[mode]}
          {since ? ` since ${new Date(since.at).toLocaleTimeString()}` : ""}
        </span>
      </div>
      {loadError ? (
        <p role="alert" className="text-xs text-warn">
          {loadError}. The terminal restarted in SLEEP.
        </p>
      ) : null}
      <Dialog
        open={pending !== null}
        onOpenChange={(open) => {
          if (!open) setPending(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Switch to {pending ? MODE_LABEL[pending] : ""}?
            </DialogTitle>
            <DialogDescription>
              {pendingInfo?.summary} No mode signs or sends a real trade.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPending(null)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                if (pending) onChange(pending);
                setPending(null);
              }}
              data-testid="terminal-mode-confirm"
            >
              Switch to {pending ? MODE_LABEL[pending] : ""}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ScoutPanel({
  markets,
  onOpen,
}: {
  markets: WalletTerminalMarket[];
  onOpen: (id: string) => void;
}) {
  const picks = rankScoutCandidates(markets);
  return (
    <section
      aria-labelledby="terminal-scout-title"
      className="flex flex-col gap-2 rounded-md border border-accent/40 bg-accent-subtle/40 p-3"
      data-testid="terminal-scout"
    >
      <div className="flex items-center justify-between gap-2">
        <h2
          id="terminal-scout-title"
          className="text-sm font-semibold text-txt"
        >
          Scout · biggest 24h moves
        </h2>
        <span className="text-[0.68rem] uppercase tracking-wide text-muted">
          Review only
        </span>
      </div>
      {picks.length === 0 ? (
        <p className="text-xs text-muted">
          Nothing in the live list moved more than 2% in 24 hours.
        </p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {picks.map((market) => (
            <li key={market.id}>
              <button
                type="button"
                onClick={() => onOpen(market.id)}
                className="rounded-md border border-border/70 bg-bg px-2.5 py-1.5 text-left text-xs hover:bg-bg-hover"
                data-testid={`terminal-scout-${market.id}`}
              >
                <span className="font-medium text-txt">{market.symbol}</span>{" "}
                <span className={changeTone(market.change24hPct)}>
                  {formatTerminalChange(market.change24hPct)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted">
        A big move is not a reason to buy. Check token safety and the chart,
        then decide yourself.
      </p>
    </section>
  );
}

const VERDICT_COPY: Record<
  WalletTokenSafetyVerdict,
  { label: string; tone: string; detail: string }
> = {
  avoid: {
    label: "Avoid",
    tone: "border-danger/50 bg-danger/10 text-danger",
    detail: "At least one power can take, lock, or block your tokens.",
  },
  caution: {
    label: "Caution",
    tone: "border-warn/50 bg-warn/10 text-warn",
    detail: "Some risks or unreported fields need a closer look.",
  },
  "no-major-flags": {
    label: "No major flags",
    tone: "border-ok/50 bg-ok/10 text-ok",
    detail: "Nothing GoPlus reported stands out. That is not proof of safety.",
  },
};

const SEVERITY_TONE: Record<WalletTokenSafetySeverity, string> = {
  danger: "text-danger",
  warn: "text-warn",
  unknown: "text-muted",
  ok: "text-ok",
};

const SEVERITY_LABEL: Record<WalletTokenSafetySeverity, string> = {
  danger: "Danger",
  warn: "Warning",
  unknown: "Not reported",
  ok: "OK",
};

const SOLANA_MINT_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function TokenSafetyPanel() {
  const [mint, setMint] = useState("");
  const [touched, setTouched] = useState(false);
  const { state, check } = useTokenSafety();
  const inputId = useId();
  const trimmed = mint.trim();
  const valid = SOLANA_MINT_PATTERN.test(trimmed);

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setTouched(true);
          if (valid) check(trimmed);
        }}
      >
        <label htmlFor={inputId} className="text-xs text-muted">
          Solana token mint address
        </label>
        <div className="flex gap-2">
          <Input
            id={inputId}
            value={mint}
            onChange={(event) => setMint(event.target.value)}
            placeholder="Paste a mint address"
            autoComplete="off"
            spellCheck={false}
            data-testid="token-safety-mint"
          />
          <Button
            type="submit"
            disabled={state.status === "loading"}
            data-testid="token-safety-check"
          >
            <ShieldCheck className="size-4" /> Check
          </Button>
        </div>
        {touched && !valid ? (
          <p role="alert" className="text-xs text-danger">
            Enter a Solana mint address (32 to 44 base58 characters).
          </p>
        ) : null}
      </form>
      {state.status === "loading" ? (
        <p role="status" className="text-sm text-muted">
          Checking token safety…
        </p>
      ) : state.status === "error" ? (
        <p
          role="alert"
          className="rounded-md border border-border/70 px-4 py-6 text-center text-sm text-muted"
        >
          Token safety report unavailable: {state.message}
        </p>
      ) : state.status === "ready" ? (
        <section
          aria-labelledby="token-safety-title"
          className="flex flex-col gap-3"
          data-testid="token-safety-report"
        >
          <div
            className={cn(
              "rounded-md border px-4 py-3",
              VERDICT_COPY[state.data.verdict].tone,
            )}
          >
            <h2 id="token-safety-title" className="text-base font-semibold">
              {VERDICT_COPY[state.data.verdict].label}
              {state.data.symbol ? ` · ${state.data.symbol}` : ""}
            </h2>
            <p className="text-xs text-txt">
              {VERDICT_COPY[state.data.verdict].detail}
            </p>
          </div>
          <ul className="divide-y divide-border/70 rounded-md border border-border/70">
            {state.data.checks.map((entry) => (
              <li
                key={entry.id}
                className="flex items-start justify-between gap-3 px-3 py-2.5"
              >
                <span>
                  <span className="block text-sm font-medium text-txt">
                    {entry.label}
                  </span>
                  <span className="text-xs text-muted">{entry.detail}</span>
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs font-medium",
                    SEVERITY_TONE[entry.severity],
                  )}
                >
                  {SEVERITY_LABEL[entry.severity]}
                </span>
              </li>
            ))}
          </ul>
          <p
            className={cn(
              "text-xs",
              state.data.stale ? "text-warn" : "text-muted",
            )}
          >
            {state.data.stale
              ? `Report may be outdated (${state.data.source.error ?? "refresh failed"}) — checked ${new Date(state.data.generatedAt).toLocaleString()}`
              : `From ${state.data.source.providerName} · checked ${new Date(state.data.generatedAt).toLocaleString()}`}
            {state.data.holderCount !== null
              ? ` · ${state.data.holderCount.toLocaleString("en-US")} holders`
              : ""}
          </p>
        </section>
      ) : (
        <p className="rounded-md border border-border/70 px-4 py-8 text-center text-sm text-muted">
          Paste a Solana mint to check mint and freeze authority, Token-2022
          extensions, holder concentration, and liquidity before you trade it.
        </p>
      )}
    </div>
  );
}

function ModeHistory({ history }: { history: OperatingModeChange[] }) {
  return (
    <section aria-labelledby="mode-history-title">
      <h2
        id="mode-history-title"
        className="mb-2 text-sm font-semibold text-txt"
      >
        Mode history
      </h2>
      {history.length === 0 ? (
        <p className="rounded-md border border-border/70 px-4 py-6 text-center text-sm text-muted">
          The terminal has stayed in SLEEP. Mode changes you confirm are listed
          here.
        </p>
      ) : (
        <ul
          className="divide-y divide-border/70 rounded-md border border-border/70"
          data-testid="mode-history"
        >
          {history.map((change) => (
            <li
              key={`${change.at}-${change.to}`}
              className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
            >
              <span className="text-txt">
                {MODE_LABEL[change.from]} → {MODE_LABEL[change.to]}
              </span>
              <span className="text-xs text-muted">
                {new Date(change.at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
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

const ALERT_REJECTION_COPY: Record<PriceAlertRejection, string> = {
  "invalid-price": "Enter a target price greater than zero.",
  "already-met": "The live price is already past that target.",
};

function describeAlert(alert: PriceAlert): string {
  return `${alert.symbol} ${alert.direction} ${formatTerminalUsd(alert.targetUsd)}`;
}

function PriceAlertForm({
  market,
  alerts,
  paused,
}: {
  market: WalletTerminalMarket;
  alerts: PriceAlertsHandle;
  paused: boolean;
}) {
  const [direction, setDirection] = useState<PriceAlertDirection>("above");
  const [target, setTarget] = useState("");
  const [error, setError] = useState<string | null>(null);
  const targetId = useId();
  const waiting = alerts.alerts.filter(
    (alert) => alert.assetId === market.id && alert.triggeredAt === null,
  );

  return (
    <section
      aria-labelledby="price-alert-title"
      className="flex flex-col gap-3 rounded-md border border-border/70 p-4"
    >
      <h2 id="price-alert-title" className="text-sm font-semibold text-txt">
        Price alert
      </h2>
      <SegmentedControl
        value={direction}
        onValueChange={setDirection}
        items={[
          { value: "above", label: "Rises above" },
          { value: "below", label: "Falls below" },
        ]}
        aria-label="Alert direction"
      />
      <form
        className="flex flex-col gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          const rejection = alerts.add({
            assetId: market.id,
            symbol: market.symbol,
            direction,
            targetUsd: Number(target),
            currentUsd: market.priceUsd,
          });
          setError(rejection ? ALERT_REJECTION_COPY[rejection] : null);
          if (!rejection) setTarget("");
        }}
      >
        <label htmlFor={targetId} className="text-xs text-muted">
          Target price (USD)
        </label>
        <div className="flex gap-2">
          <Input
            id={targetId}
            inputMode="decimal"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            placeholder={market.priceUsd.toString()}
            data-testid="price-alert-target"
          />
          <Button type="submit" variant="outline" data-testid="price-alert-add">
            <Bell className="size-4" /> Set
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      ) : null}
      {waiting.length > 0 ? (
        <ul className="flex flex-col gap-1 text-xs">
          {waiting.map((alert) => (
            <li
              key={alert.id}
              className="flex items-center justify-between gap-2 text-txt"
            >
              <span>
                {alert.direction === "above" ? "Above" : "Below"}{" "}
                {formatTerminalUsd(alert.targetUsd)}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => alerts.remove(alert.id)}
                aria-label={`Remove alert ${describeAlert(alert)}`}
              >
                Remove
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-xs text-muted">
        {paused
          ? "Alerts are paused while the terminal is OFF."
          : "Checked against live prices while the terminal is open in HUNT or SLEEP."}
      </p>
    </section>
  );
}

function FiredAlerts({ alerts }: { alerts: PriceAlertsHandle }) {
  if (alerts.fired.length === 0 && !alerts.loadError) return null;
  return (
    <div className="flex flex-col gap-2" data-testid="price-alerts-fired">
      {alerts.loadError ? (
        <p role="alert" className="text-xs text-warn">
          {alerts.loadError}. Saved alerts were cleared.
        </p>
      ) : null}
      {alerts.fired.map((alert) => (
        <div
          key={alert.id}
          role="alert"
          className="flex items-center justify-between gap-3 rounded-md border border-accent/50 bg-accent-subtle px-3 py-2 text-sm text-txt"
        >
          <span className="flex items-center gap-2">
            <Bell className="size-4 shrink-0 text-accent" />
            {alert.symbol}{" "}
            {alert.direction === "above" ? "rose above" : "fell below"}{" "}
            {formatTerminalUsd(alert.targetUsd)}
            {alert.triggeredPriceUsd !== null
              ? ` (now ${formatTerminalUsd(alert.triggeredPriceUsd)})`
              : ""}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => alerts.dismiss(alert.id)}
            aria-label={`Dismiss alert ${describeAlert(alert)}`}
          >
            <X className="size-4" />
          </Button>
        </div>
      ))}
    </div>
  );
}

function AlertList({
  alerts,
  paused,
  onOpen,
}: {
  alerts: PriceAlertsHandle;
  paused: boolean;
  onOpen: (id: string) => void;
}) {
  if (alerts.alerts.length === 0) return null;
  return (
    <section aria-labelledby="price-alerts-title" data-testid="price-alerts">
      <h2
        id="price-alerts-title"
        className="mb-2 text-sm font-semibold text-txt"
      >
        Price alerts{paused ? " · paused" : ""}
      </h2>
      <ul className="divide-y divide-border/70 rounded-md border border-border/70">
        {alerts.alerts.map((alert) => (
          <li
            key={alert.id}
            className="flex items-center justify-between gap-3 px-3 py-2 text-sm"
          >
            <button
              type="button"
              className="text-left text-txt hover:underline"
              onClick={() => onOpen(alert.assetId)}
            >
              {alert.symbol} {alert.direction === "above" ? "above" : "below"}{" "}
              {formatTerminalUsd(alert.targetUsd)}
            </button>
            <span className="flex items-center gap-2">
              <span
                className={cn(
                  "text-xs",
                  alert.triggeredAt === null ? "text-muted" : "text-ok",
                )}
              >
                {alert.triggeredAt === null
                  ? "Waiting"
                  : `Triggered ${new Date(alert.triggeredAt).toLocaleTimeString()}`}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => alerts.remove(alert.id)}
                aria-label={`Remove alert ${describeAlert(alert)}`}
              >
                Remove
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function AssetDetail({
  market,
  watched,
  onToggleWatch,
  onBack,
  paper,
  alerts,
  alertsPaused,
}: {
  market: WalletTerminalMarket;
  watched: boolean;
  onToggleWatch: () => void;
  onBack: () => void;
  paper: PaperLedgerState;
  alerts: PriceAlertsHandle;
  alertsPaused: boolean;
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
        <div className="flex flex-col gap-4">
          <OrderTicket key={market.id} market={market} paper={paper} />
          <PriceAlertForm
            key={`alert-${market.id}`}
            market={market}
            alerts={alerts}
            paused={alertsPaused}
          />
        </div>
      </div>
    </div>
  );
}

function PaperPortfolio({
  paper,
  prices,
  marketsById,
  onOpen,
  modeHistory,
}: {
  paper: PaperLedgerState;
  prices: ReadonlyMap<string, number>;
  marketsById: ReadonlyMap<string, WalletTerminalMarket>;
  onOpen: (id: string) => void;
  modeHistory: OperatingModeChange[];
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
      <ModeHistory history={modeHistory} />
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
  const mode = useOperatingMode();
  const { state: marketsState, refresh: refreshMarkets } = useTerminalMarkets(
    pollsMarkets(mode.mode),
  );
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
  const alertsPaused = !alertsActive(mode.mode);
  const alerts = usePriceAlerts(prices, !alertsPaused);
  const selected = assetId ? marketsById.get(assetId) : undefined;

  const open = (id: string) => {
    setAssetId(id);
    if (section === "wallet") setSection("markets");
  };

  let body: React.ReactNode;
  if (section === "wallet") {
    body = <InventoryAppView />;
  } else if (section === "safety") {
    body = <TokenSafetyPanel />;
  } else if (marketsState.status === "idle" && section !== "portfolio") {
    body = (
      <p className="rounded-md border border-border/70 px-4 py-8 text-center text-sm text-muted">
        The terminal is off, so no prices have loaded. Refresh prices to trade
        manually, or switch to SLEEP for live updates.
      </p>
    );
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
        alerts={alerts}
        alertsPaused={alertsPaused}
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
        modeHistory={mode.history}
      />
    );
  } else {
    body = (
      <div className="flex flex-col gap-4">
        {mode.mode === "hunt" && section === "markets" ? (
          <ScoutPanel markets={markets ?? []} onOpen={open} />
        ) : null}
        {section === "watchlist" ? (
          <AlertList alerts={alerts} paused={alertsPaused} onOpen={open} />
        ) : null}
        <MarketList
          key={section}
          markets={markets ?? []}
          watchlist={watchlist.ids}
          onToggleWatch={watchlist.toggle}
          onOpen={open}
          watchOnly={section === "watchlist"}
        />
      </div>
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
          <ModeControl
            mode={mode.mode}
            history={mode.history}
            loadError={mode.loadError}
            onChange={mode.change}
          />
          {section !== "wallet" && section !== "safety" ? (
            <MarketStatus
              state={marketsState}
              mode={mode.mode}
              onRefresh={refreshMarkets}
            />
          ) : null}
          <FiredAlerts alerts={alerts} />
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
