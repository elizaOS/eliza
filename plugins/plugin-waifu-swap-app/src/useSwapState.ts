/**
 * State hook for the swap AppView. Owns the token-in/token-out selection, the
 * amount + slippage form state, the live quote (local estimate, opportunistically
 * upgraded with a backend quote), and the guarded execute lifecycle. Kept
 * separate from the view so the .tsx file exports only React components
 * (Fast-Refresh friendly). Mirrors `useImageGenState`.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  type BackendQuoteFields,
  fetchBackendQuote,
  prepareSwap,
} from "./swap-client";
import {
  resolveWaifuSwapConfig,
  type WaifuSwapRuntimeConfig,
} from "./swap-config";
import {
  clampSlippage,
  DEFAULT_PANCAKE_V3_FEE,
  DEFAULT_SLIPPAGE_PCT,
  estimateLocalQuote,
  isSwapError,
  type PancakeV3Fee,
  SWAP_EXECUTE_ENABLED,
  type SwapError,
  type SwapQuote,
  type SwapToken,
} from "./swap-contracts";

export interface SwapStateOptions {
  /** Host-supplied agent token address (wins over ambient config). */
  agentTokenAddress?: string;
  /** Host-supplied swap-eligible token list (wins over ambient config). */
  tokens?: readonly SwapToken[];
  /** Called when the backend reports the capability is unavailable (404). */
  onUnavailable?: () => void;
}

/** Terminal outcome of a confirmed swap press. */
export type SwapExecuteOutcome =
  | { kind: "stubbed"; message: string }
  | { kind: "prepared"; to: string }
  | { kind: "error"; error: SwapError };

export interface SwapState {
  config: WaifuSwapRuntimeConfig;
  tokens: readonly SwapToken[];
  tokenIn: SwapToken | null;
  tokenOut: SwapToken | null;
  setTokenIn: (token: SwapToken) => void;
  setTokenOut: (token: SwapToken) => void;
  reverse: () => void;
  amountIn: string;
  setAmountIn: (next: string) => void;
  slippagePct: number;
  setSlippagePct: (next: number) => void;
  fee: PancakeV3Fee;
  setFee: (next: PancakeV3Fee) => void;
  quote: SwapQuote | null;
  amountValid: boolean;
  canSwap: boolean;
  executeEnabled: boolean;
  quoting: boolean;
  executing: boolean;
  error: SwapError | null;
  outcome: SwapExecuteOutcome | null;
  executeSwap: () => Promise<void>;
}

const QUOTE_DEBOUNCE_MS = 350;

export function useSwapState(options: SwapStateOptions = {}): SwapState {
  const config = useMemo(
    () =>
      resolveWaifuSwapConfig({
        agentTokenAddress: options.agentTokenAddress,
        tokens: options.tokens,
      }),
    [options.agentTokenAddress, options.tokens],
  );

  const tokens = config.tokens;
  const onUnavailable = options.onUnavailable;

  const [tokenIn, setTokenIn] = useState<SwapToken | null>(
    () => tokens[0] ?? null,
  );
  const [tokenOut, setTokenOut] = useState<SwapToken | null>(
    () => tokens[1] ?? null,
  );
  const [amountIn, setAmountIn] = useState("");
  const [slippagePct, setSlippageRaw] = useState(DEFAULT_SLIPPAGE_PCT);
  const [fee, setFee] = useState<PancakeV3Fee>(DEFAULT_PANCAKE_V3_FEE);

  const [backendQuote, setBackendQuote] = useState<BackendQuoteFields | null>(
    null,
  );
  const [quoting, setQuoting] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [error, setError] = useState<SwapError | null>(null);
  const [outcome, setOutcome] = useState<SwapExecuteOutcome | null>(null);

  const setSlippagePct = useCallback((next: number) => {
    setSlippageRaw(clampSlippage(next));
  }, []);

  const parsedAmount = Number.parseFloat(amountIn);
  const amountValid = Number.isFinite(parsedAmount) && parsedAmount > 0;

  // Base quote is always the transparent local estimate; it never blocks the UI.
  const localQuote = useMemo<SwapQuote | null>(() => {
    if (!tokenIn || !tokenOut || !amountValid) return null;
    return estimateLocalQuote(
      tokenIn,
      tokenOut,
      parsedAmount,
      slippagePct,
      fee,
    );
  }, [tokenIn, tokenOut, amountValid, parsedAmount, slippagePct, fee]);

  // If a backend quote arrives for the current inputs, prefer its numbers.
  const quote = useMemo<SwapQuote | null>(() => {
    if (!localQuote) return null;
    if (!backendQuote) return localQuote;
    const minAmountOut =
      backendQuote.minAmountOut ??
      backendQuote.amountOut * (1 - localQuote.slippagePct / 100);
    return {
      ...localQuote,
      amountOut: backendQuote.amountOut,
      minAmountOut: Math.max(0, minAmountOut),
      priceImpactPct: backendQuote.priceImpactPct ?? localQuote.priceImpactPct,
      source: "backend",
    };
  }, [localQuote, backendQuote]);

  // Opportunistically upgrade the local estimate with the backend `quote`
  // action. A 501 (handler not wired yet) is swallowed — the local estimate
  // stays. Other typed errors don't disturb the display either; they only
  // suppress the upgrade. Debounced + abortable to avoid hammering on keystroke.
  // The prior backend quote is dropped at the top of each run so it never
  // briefly applies to inputs it was not computed for.
  useEffect(() => {
    setBackendQuote(null);
    if (!tokenIn || !tokenOut || !amountValid) return;
    if (!config.agentTokenAddress) return;
    if (!config.appInvokeKey && !config.stewardJwt) return;

    let cancelled = false;
    const handle = setTimeout(() => {
      setQuoting(true);
      void fetchBackendQuote(config, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
        fee,
      })
        .then((fields) => {
          if (!cancelled) setBackendQuote(fields);
        })
        .catch((caught: unknown) => {
          if (cancelled) return;
          if (isSwapError(caught) && caught.kind === "not-available") {
            onUnavailable?.();
          }
          // Local estimate remains the display source.
        })
        .finally(() => {
          if (!cancelled) setQuoting(false);
        });
    }, QUOTE_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [config, tokenIn, tokenOut, amountIn, amountValid, fee, onUnavailable]);

  const reverse = useCallback(() => {
    setTokenIn((prevIn) => {
      setTokenOut(prevIn);
      return tokenOut;
    });
  }, [tokenOut]);

  const handleSetTokenIn = useCallback(
    (token: SwapToken) => {
      // Disallow selecting the same token on both sides; swap if collided.
      setTokenIn(token);
      if (tokenOut && token.address === tokenOut.address) {
        setTokenOut((prev) => (prev ? tokenIn : prev));
      }
    },
    [tokenOut, tokenIn],
  );

  const handleSetTokenOut = useCallback(
    (token: SwapToken) => {
      setTokenOut(token);
      if (tokenIn && token.address === tokenIn.address) {
        setTokenIn((prev) => (prev ? tokenOut : prev));
      }
    },
    [tokenIn, tokenOut],
  );

  const canSwap =
    amountValid &&
    Boolean(tokenIn) &&
    Boolean(tokenOut) &&
    Boolean(quote) &&
    !executing;

  const executeSwap = useCallback(async () => {
    if (!canSwap || !tokenIn || !tokenOut || !quote) return;
    setError(null);
    setOutcome(null);

    // SWAP_EXECUTE_TODO: execution is intentionally stubbed until the backend
    // `pancakeswap-v3:swap` handler + agent signer land. Never fabricate a money
    // path — surface a clear, honest "not enabled yet" outcome instead.
    if (!SWAP_EXECUTE_ENABLED) {
      setOutcome({
        kind: "stubbed",
        message:
          "on-chain swap execution is not enabled yet — this is a quote-only preview",
      });
      return;
    }

    setExecuting(true);
    try {
      const tx = await prepareSwap(config, {
        tokenIn: tokenIn.address,
        tokenOut: tokenOut.address,
        amountIn,
        fee,
        minAmountOut: String(quote.minAmountOut),
      });
      setOutcome({ kind: "prepared", to: tx.to });
    } catch (caught) {
      const err: SwapError = isSwapError(caught)
        ? caught
        : {
            kind: "unknown",
            status: 500,
            message: caught instanceof Error ? caught.message : "swap failed",
          };
      if (err.kind === "not-available") onUnavailable?.();
      setError(err);
      setOutcome({ kind: "error", error: err });
    } finally {
      setExecuting(false);
    }
  }, [canSwap, tokenIn, tokenOut, quote, config, amountIn, fee, onUnavailable]);

  return {
    config,
    tokens,
    tokenIn,
    tokenOut,
    setTokenIn: handleSetTokenIn,
    setTokenOut: handleSetTokenOut,
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
    executeEnabled: SWAP_EXECUTE_ENABLED,
    quoting,
    executing,
    error,
    outcome,
    executeSwap,
  };
}
