/**
 * SwapSpatialView — the swap surface authored once with the spatial vocabulary,
 * so it renders correctly wherever it is displayed:
 *
 *   - GUI / XR — mounted in `<SpatialSurface>` (DOM; XR scales up).
 *   - TUI      — rendered to real terminal lines by the agent terminal, via
 *                `registerSpatialTerminalView` (see `register-terminal-view.tsx`).
 *
 * It is purely presentational (a snapshot + an action callback in, primitives
 * out) and imports only the cross-modality primitives, so it is safe to render
 * in the Node agent process where the terminal lives (no @elizaos/app-core
 * React-DOM client or swap-capability runtime import reaches the bundle).
 *
 * Execution stays honest: the swap action is quote-only (SWAP_EXECUTE_ENABLED is
 * false), so the outcome line surfaces the "not enabled yet" preview message
 * rather than fabricating a money path.
 */

import { Button, Card, Divider, Field, HStack, Text } from "@elizaos/ui/spatial";

/** Projected, display-only quote numbers. */
export interface SwapSnapshotQuote {
  amountOut: number;
  minAmountOut: number;
  priceImpactPct: number;
  source: "local-estimate" | "backend";
}

/** The full presentational state the view renders from. */
export interface SwapSnapshot {
  tokenInSymbol: string;
  tokenOutSymbol: string;
  tokenSymbols: string[];
  amountIn: string;
  slippagePct: number;
  quote: SwapSnapshotQuote | null;
  canSwap: boolean;
  quoting: boolean;
  executing: boolean;
  error: { message: string } | null;
  outcome: { message: string } | null;
}

export interface SwapSpatialViewProps {
  snapshot: SwapSnapshot;
  /**
   * Dispatched action ids: `token-in:<symbol>`, `token-out:<symbol>`,
   * `amount:<value>`, `swap`.
   */
  onAction?: (action: string) => void;
}

function formatAmount(value: number): string {
  if (!Number.isFinite(value)) return "0";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 0,
    maximumFractionDigits: value > 1 ? 4 : 6,
  });
}

function formatImpact(pct: number): string {
  if (!Number.isFinite(pct)) return "0.00%";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function SwapSpatialView({ snapshot, onAction }: SwapSpatialViewProps) {
  const { quote, error, outcome, quoting, executing } = snapshot;
  const impactDanger = (quote?.priceImpactPct ?? 0) < -1;

  return (
    <Card title="Swap" gap={1} padding={1}>
      <HStack gap={1} align="center">
        <Text style="caption" tone="muted" grow={1}>
          PancakeSwap v3
        </Text>
        <Text style="caption" tone="muted">
          slippage {snapshot.slippagePct}%
        </Text>
      </HStack>

      <Divider label="from" />
      <Field
        kind="select"
        label="from"
        value={snapshot.tokenInSymbol}
        options={snapshot.tokenSymbols}
        disabled={executing}
        onChange={(v) => onAction?.(`token-in:${v}`)}
      />
      <Field
        kind="number"
        label="amount"
        value={snapshot.amountIn}
        placeholder="0.0"
        disabled={executing}
        onChange={(v) => onAction?.(`amount:${v}`)}
      />

      <Divider label="to" />
      <Field
        kind="select"
        label="to"
        value={snapshot.tokenOutSymbol}
        options={snapshot.tokenSymbols}
        disabled={executing}
        onChange={(v) => onAction?.(`token-out:${v}`)}
      />
      {quote ? (
        <HStack gap={1} align="center" wrap>
          <Text grow={1}>
            ≈ {formatAmount(quote.amountOut)} {snapshot.tokenOutSymbol}
          </Text>
          <Text style="caption" tone="muted">
            {quote.source === "backend" ? "live" : "estimated"}
          </Text>
        </HStack>
      ) : (
        <Text tone="muted" style="caption">
          {quoting ? "quoting…" : "enter an amount"}
        </Text>
      )}
      {quote ? (
        <HStack gap={1} align="center" wrap>
          <Text style="caption" tone="muted" grow={1}>
            min {formatAmount(quote.minAmountOut)} {snapshot.tokenOutSymbol}
          </Text>
          <Text style="caption" tone={impactDanger ? "danger" : "muted"}>
            impact {formatImpact(quote.priceImpactPct)}
          </Text>
        </HStack>
      ) : null}

      <HStack gap={1}>
        <Button
          grow={1}
          agent="swap"
          disabled={!snapshot.canSwap}
          onPress={() => onAction?.("swap")}
        >
          {executing ? "preparing…" : "Swap"}
        </Button>
      </HStack>

      {error ? (
        <Text tone="danger" style="caption">
          {error.message}
        </Text>
      ) : null}
      {outcome ? (
        <Text tone="muted" style="caption">
          {outcome.message}
        </Text>
      ) : null}
    </Card>
  );
}
