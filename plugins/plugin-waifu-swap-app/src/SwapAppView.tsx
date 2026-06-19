import type { OverlayAppContext } from "@elizaos/app-core";
import { Button, PagePanel, Spinner } from "@elizaos/app-core";
import { useAgentElement } from "@elizaos/ui/agent-surface";
import {
  ArrowDown,
  ArrowLeft,
  ArrowLeftRight,
  CheckCircle2,
  Info,
  Settings2,
} from "lucide-react";
import { type ReactNode, useId } from "react";
import {
  PANCAKE_V3_FEE_TIERS,
  type PancakeV3Fee,
  SLIPPAGE_PRESETS,
  type SwapToken,
} from "./swap-contracts";
import { useSwapState } from "./useSwapState";

function formatAmount(value: number, maxFraction = 6): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: value > 1 ? 4 : maxFraction,
  });
}

function formatImpact(pct: number): string {
  if (!Number.isFinite(pct)) return "0.00%";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function TokenChip({ token }: { token: SwapToken }) {
  return (
    <span className="inline-flex items-center gap-2 rounded-md border border-border bg-bg-accent px-2.5 py-1.5">
      <span className="grid h-5 w-5 place-items-center rounded-full border border-border/40 bg-card text-[10px] font-semibold text-muted">
        {token.symbol.slice(0, 2).toUpperCase()}
      </span>
      <span className="font-mono text-xs text-txt">{token.symbol}</span>
    </span>
  );
}

function TokenSelect({
  label,
  selected,
  tokens,
  exclude,
  disabled,
  onSelect,
}: {
  label: string;
  selected: SwapToken | null;
  tokens: readonly SwapToken[];
  exclude: SwapToken | null;
  disabled: boolean;
  onSelect: (token: SwapToken) => void;
}) {
  const selectId = useId();
  const options = tokens.filter(
    (token) => !exclude || token.address !== exclude.address,
  );
  return (
    <div className="flex items-center gap-2">
      {selected ? <TokenChip token={selected} /> : null}
      <label className="sr-only" htmlFor={selectId}>
        {label}
      </label>
      <select
        id={selectId}
        value={selected?.address ?? ""}
        disabled={disabled || options.length === 0}
        onChange={(event) => {
          const next = tokens.find(
            (token) => token.address === event.target.value,
          );
          if (next) onSelect(next);
        }}
        className="rounded-md border border-border bg-bg-accent px-2 py-1.5 text-xs text-txt outline-none transition-colors focus:border-accent/50 disabled:opacity-60"
      >
        {selected && !options.some((t) => t.address === selected.address) ? (
          <option value={selected.address}>{selected.symbol}</option>
        ) : null}
        {options.map((token) => (
          <option key={token.address} value={token.address}>
            {token.symbol}
          </option>
        ))}
      </select>
    </div>
  );
}

function DetailRow({
  label,
  children,
  tone,
}: {
  label: string;
  children: ReactNode;
  tone?: "default" | "danger";
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd
        className={`tabular-nums ${tone === "danger" ? "text-danger" : "text-txt"}`}
      >
        {children}
      </dd>
    </div>
  );
}

export interface SwapAppViewProps extends OverlayAppContext {
  /** Optional host override for which agent's swap capability to invoke. */
  agentTokenAddress?: string;
  /** Optional host-supplied swap-eligible token list. */
  tokens?: readonly SwapToken[];
  /** Raised when the backend reports the capability is unavailable (404). */
  onUnavailable?: () => void;
}

export function SwapAppView({
  exitToApps,
  agentTokenAddress,
  tokens: tokensProp,
  onUnavailable,
}: SwapAppViewProps) {
  const amountId = useId();
  const {
    config,
    tokens,
    tokenIn,
    tokenOut,
    setTokenIn,
    setTokenOut,
    reverse,
    amountIn,
    setAmountIn,
    slippagePct,
    setSlippagePct,
    fee,
    setFee,
    quote,
    amountValid,
    canSwap,
    executeEnabled,
    quoting,
    executing,
    error,
    outcome,
    executeSwap,
  } = useSwapState({ agentTokenAddress, tokens: tokensProp, onUnavailable });

  const backButton = useAgentElement<HTMLButtonElement>({
    id: "action-back",
    role: "button",
    label: "Back to apps",
    group: "swap-header",
    description: "Exit the swap view and return to the apps overlay",
  });
  const reverseButton = useAgentElement<HTMLButtonElement>({
    id: "action-reverse",
    role: "button",
    label: "Reverse direction",
    group: "swap-form",
    description: "Swap the token-in and token-out sides",
  });
  const swapButton = useAgentElement<HTMLButtonElement>({
    id: "action-swap",
    role: "button",
    label: "Swap",
    group: "swap-form",
    description: "Execute the swap with the current quote",
    status: executing ? "active" : "inactive",
  });
  const amountField = useAgentElement<HTMLInputElement>({
    id: "field-amount",
    role: "number-input",
    label: "Amount in",
    group: "swap-form",
    description: "Amount of the input token to swap",
  });

  const impactDanger = (quote?.priceImpactPct ?? 0) < -1;

  return (
    <div
      data-testid="swap-shell"
      className="fixed inset-0 z-50 flex h-[100vh] flex-col overflow-hidden bg-bg supports-[height:100dvh]:h-[100dvh]"
    >
      <div className="flex shrink-0 items-center gap-3 border-b border-border/20 bg-bg/80 px-4 py-3 backdrop-blur-sm">
        <Button
          ref={backButton.ref}
          {...backButton.agentProps}
          variant="ghost"
          size="icon"
          className="h-9 w-9 text-muted hover:text-txt"
          onClick={exitToApps}
          aria-label="Back"
        >
          <ArrowLeft className="h-4 w-4" />
        </Button>

        <div className="min-w-0">
          <h1 className="text-base font-semibold text-txt">Swap</h1>
        </div>

        <div className="flex-1" />

        <span className="inline-flex items-center gap-1.5 rounded-full border border-border/35 bg-bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted">
          PancakeSwap v3
        </span>
      </div>

      <div className="chat-native-scrollbar flex-1 overflow-y-auto px-4 py-4 sm:px-6">
        <div className="mx-auto max-w-xl space-y-4">
          {!config.agentTokenAddress && (
            <PagePanel.Notice tone="warning">
              No agent is configured for swapping.
            </PagePanel.Notice>
          )}

          {/* From */}
          <section className="rounded-lg border border-border/24 bg-card/50 p-4">
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              <span>from</span>
            </div>
            <div className="flex items-center gap-3">
              <TokenSelect
                label="From token"
                selected={tokenIn}
                tokens={tokens}
                exclude={tokenOut}
                disabled={executing}
                onSelect={setTokenIn}
              />
              <input
                ref={amountField.ref}
                {...amountField.agentProps}
                id={amountId}
                value={amountIn}
                inputMode="decimal"
                placeholder="0.0"
                disabled={executing}
                onChange={(event) => setAmountIn(event.target.value)}
                className="ml-auto w-full bg-transparent text-right font-mono text-2xl text-txt tabular-nums outline-none placeholder:text-muted disabled:opacity-60"
                aria-label="Amount in"
              />
            </div>
          </section>

          {/* Direction */}
          <div className="-my-2 flex justify-center">
            <Button
              ref={reverseButton.ref}
              {...reverseButton.agentProps}
              variant="ghost"
              size="icon"
              className="h-9 w-9 rounded-full border border-border/40 bg-bg text-muted hover:text-accent"
              onClick={reverse}
              disabled={executing}
              aria-label="Reverse direction"
            >
              <ArrowDown className="h-4 w-4" />
            </Button>
          </div>

          {/* To */}
          <section className="rounded-lg border border-border/24 bg-card/50 p-4">
            <div className="mb-2 flex items-center justify-between text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              <span>to (estimate)</span>
              {quoting ? (
                <span className="inline-flex items-center gap-1.5 normal-case text-[10px] tracking-normal">
                  <Spinner className="h-3 w-3" />
                  quoting
                </span>
              ) : quote ? (
                <span className="normal-case text-[10px] tracking-normal">
                  {quote.source === "backend" ? "live quote" : "estimated"}
                </span>
              ) : null}
            </div>
            <div className="flex items-center gap-3">
              <TokenSelect
                label="To token"
                selected={tokenOut}
                tokens={tokens}
                exclude={tokenIn}
                disabled={executing}
                onSelect={setTokenOut}
              />
              <div className="ml-auto font-mono text-2xl text-txt/85 tabular-nums">
                {quote ? formatAmount(quote.amountOut) : "0.0"}
              </div>
            </div>
          </section>

          {/* Slippage + fee controls */}
          <section className="rounded-lg border border-border/24 bg-card/50 p-4">
            <div className="mb-2 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              <Settings2 className="h-3.5 w-3.5" />
              slippage tolerance
            </div>
            <div className="flex flex-wrap gap-1.5">
              {SLIPPAGE_PRESETS.map((preset) => (
                <Button
                  key={preset}
                  type="button"
                  variant={preset === slippagePct ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 font-mono text-xs tabular-nums"
                  disabled={executing}
                  onClick={() => setSlippagePct(preset)}
                  aria-pressed={preset === slippagePct}
                >
                  {preset}%
                </Button>
              ))}
            </div>

            <div className="mt-3 mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted">
              fee tier
            </div>
            <div className="flex flex-wrap gap-1.5">
              {PANCAKE_V3_FEE_TIERS.map((tier: PancakeV3Fee) => (
                <Button
                  key={tier}
                  type="button"
                  variant={tier === fee ? "secondary" : "ghost"}
                  size="sm"
                  className="h-7 px-2 font-mono text-xs tabular-nums"
                  disabled={executing}
                  onClick={() => setFee(tier)}
                  aria-pressed={tier === fee}
                >
                  {(tier / 10000).toFixed(2)}%
                </Button>
              ))}
            </div>
          </section>

          {/* Route detail */}
          {quote && amountValid ? (
            <dl className="space-y-2 rounded-lg border border-border/24 bg-bg-accent px-4 py-3 text-xs">
              <DetailRow label="route">
                <span className="inline-flex items-center gap-1.5">
                  <ArrowLeftRight className="h-3.5 w-3.5 text-muted" />
                  via PancakeSwap v3
                </span>
              </DetailRow>
              <DetailRow
                label="price impact"
                tone={impactDanger ? "danger" : "default"}
              >
                {formatImpact(quote.priceImpactPct)}
              </DetailRow>
              <DetailRow label="slippage">{quote.slippagePct}%</DetailRow>
              <DetailRow label="minimum received">
                {formatAmount(quote.minAmountOut)} {tokenOut?.symbol ?? ""}
              </DetailRow>
            </dl>
          ) : null}

          {/* Errors */}
          {error && (
            <PagePanel.Notice
              tone={error.kind === "auth" ? "accent" : "danger"}
            >
              {error.message}
            </PagePanel.Notice>
          )}

          {/* Outcome */}
          {outcome?.kind === "stubbed" && (
            <div className="flex items-start gap-2 rounded-lg border border-border/24 bg-bg-accent px-4 py-3 text-sm text-muted">
              <Info className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{outcome.message}</span>
            </div>
          )}
          {outcome?.kind === "prepared" && (
            <div className="flex items-start gap-2 rounded-lg border border-ok/35 bg-ok/12 px-4 py-3 text-sm text-ok">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
              <span>
                transaction prepared for {shortAddress(outcome.to)} — sign in
                your wallet to complete
              </span>
            </div>
          )}

          {/* Swap CTA */}
          <Button
            ref={swapButton.ref}
            {...swapButton.agentProps}
            type="button"
            variant="default"
            className="w-full gap-2"
            disabled={!canSwap}
            onClick={() => void executeSwap()}
          >
            {executing ? (
              <>
                <Spinner className="h-4 w-4" />
                preparing swap
              </>
            ) : (
              <>
                <ArrowLeftRight className="h-4 w-4" />
                {executeEnabled ? "swap" : "preview swap"}
              </>
            )}
          </Button>

          {!executeEnabled && (
            <p className="text-center text-xs text-muted">
              quote-only preview — on-chain execution lands when the agent
              signer is enabled
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
