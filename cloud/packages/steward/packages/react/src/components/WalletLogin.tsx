import type { StewardAuthResult } from "@stwd/sdk";
import React, { useEffect, useMemo, useState } from "react";

// ─── Props ───────────────────────────────────────────────────────────────────

export type WalletChains = "evm" | "solana" | "both";

export interface WalletLoginClassOverrides {
  /** Outer container (controls layout / two-column). */
  root?: string;
  /** Per-chain column wrapper. */
  column?: string;
  /** Column heading (EVM / Solana label). */
  heading?: string;
  /** Status line under the connector (address, chain name). */
  status?: string;
  /** The "Sign in with..." action button. */
  signButton?: string;
  /** Inline error row. */
  error?: string;
  /** Muted hint text ("Connect a wallet to continue"). */
  hint?: string;
}

export interface WalletLoginProps {
  /** Which chain family(ies) to render. Defaults to "both". */
  chains?: WalletChains;
  /** Fires after a successful SIWE / SIWS exchange. */
  onSuccess?: (result: StewardAuthResult, kind: "evm" | "solana") => void;
  /** Fires on any wallet, signing, or server error. */
  onError?: (error: Error, kind: "evm" | "solana") => void;
  /** Extra className appended to the root element. */
  className?: string;
  /** Fine-grained className overrides for internal slots. */
  classes?: WalletLoginClassOverrides;
  /** Label for the EVM column. Default: "Ethereum". */
  evmLabel?: string;
  /** Label for the Solana column. Default: "Solana". */
  solanaLabel?: string;
  /** Override the EVM sign button label. Default: "Sign in with {wallet}". */
  evmSignLabel?: (walletName: string | undefined) => string;
  /** Override the Solana sign button label. Default: "Sign in with {wallet}". */
  solanaSignLabel?: (walletName: string | undefined) => string;
}

export interface WalletLoginPanelProps {
  classes?: WalletLoginClassOverrides;
  onSuccess?: WalletLoginProps["onSuccess"];
  onError?: WalletLoginProps["onError"];
  label: string;
  signLabel?: (walletName: string | undefined) => string;
}

export function cx(...parts: Array<string | undefined | false>): string {
  return parts.filter(Boolean).join(" ");
}

// Dynamic imports so @solana/* is never resolved when chains="evm" (and vice
// versa). We avoid React.lazy here because renderToString does not support
// Suspense; this pattern renders a fallback during load and works on both
// client and server.
type PanelComponent = React.ComponentType<WalletLoginPanelProps>;

function useDynamicPanel(
  enabled: boolean,
  loader: () => Promise<{ default: PanelComponent }>,
): PanelComponent | null {
  const [Panel, setPanel] = useState<PanelComponent | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    loader().then((mod) => {
      if (!cancelled) setPanel(() => mod.default);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, loader]);
  return Panel;
}

/**
 * WalletLogin, first-class Steward wallet sign-in.
 *
 * Supports EVM (wagmi + RainbowKit) and Solana (@solana/wallet-adapter-react).
 * Must live inside a `<StewardProvider auth={...}>` and, for each enabled chain,
 * the matching wallet provider (see `EVMWalletProvider`, `SolanaWalletProvider`).
 *
 * @example
 * <WalletLogin
 *   chains="both"
 *   onSuccess={(res, kind) => console.log("signed in via", kind, res.token)}
 * />
 */
export function WalletLogin({
  chains = "both",
  onSuccess,
  onError,
  className,
  classes,
  evmLabel = "Ethereum",
  solanaLabel = "Solana",
  evmSignLabel,
  solanaSignLabel,
}: WalletLoginProps) {
  const layoutClass = useMemo(() => {
    if (chains === "both") return "stwd-wallet-root stwd-wallet-root-two";
    return "stwd-wallet-root stwd-wallet-root-one";
  }, [chains]);

  const wantEvm = chains === "evm" || chains === "both";
  const wantSolana = chains === "solana" || chains === "both";

  const EVMPanel = useDynamicPanel(
    wantEvm,
    () => import("./WalletLogin.EVM.js") as Promise<{ default: PanelComponent }>,
  );
  const SolanaPanel = useDynamicPanel(
    wantSolana,
    () => import("./WalletLogin.Solana.js") as Promise<{ default: PanelComponent }>,
  );

  return (
    <div className={cx(layoutClass, classes?.root, className)}>
      {wantEvm &&
        (EVMPanel ? (
          <EVMPanel
            classes={classes}
            onSuccess={onSuccess}
            onError={onError}
            label={evmLabel}
            signLabel={evmSignLabel}
          />
        ) : (
          <div className="stwd-wallet-loading" data-testid="wallet-loading-evm">
            {evmLabel}
          </div>
        ))}
      {wantSolana &&
        (SolanaPanel ? (
          <SolanaPanel
            classes={classes}
            onSuccess={onSuccess}
            onError={onError}
            label={solanaLabel}
            signLabel={solanaSignLabel}
          />
        ) : (
          <div className="stwd-wallet-loading" data-testid="wallet-loading-solana">
            {solanaLabel}
          </div>
        ))}
    </div>
  );
}
