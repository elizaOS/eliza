import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { StewardAuth, StewardAuthResult } from "@stwd/sdk";
import NetworkBase from "@web3icons/react/icons/networks/NetworkBase";
import NetworkBinanceSmartChain from "@web3icons/react/icons/networks/NetworkBinanceSmartChain";
import NetworkEthereum from "@web3icons/react/icons/networks/NetworkEthereum";
import TokenSOL from "@web3icons/react/icons/tokens/TokenSOL";
import { useCallback, useEffect, useRef } from "react";
import { type Connector, useAccount, useConnect, useSignMessage } from "wagmi";
import { useT } from "@/providers/I18nProvider";

// Phantom injects itself as an Ethereum provider but must never be used for
// SIWE — it is Solana-first and the user's intent for SIWE is a real EVM wallet.
// We mirror the previous EIP-1193 isPhantom check, but against the connector's
// underlying provider so the wagmi store stays the source of truth.
async function isPhantomConnector(connector: Connector): Promise<boolean> {
  const id = connector.id.toLowerCase();
  const name = (connector.name ?? "").toLowerCase();
  if (id.includes("phantom") || name.includes("phantom")) return true;
  try {
    const provider = (await connector.getProvider()) as unknown;
    if (provider !== null && typeof provider === "object") {
      if (Reflect.get(provider, "isPhantom") === true) return true;
    }
  } catch {
    // If a connector can't surface its provider yet, treat it as non-Phantom
    // and let downstream connect() surface any real failure.
  }
  return false;
}

// Pick the best EVM connector that is NOT Phantom. Prefer an "injected"-style
// connector (MetaMask, generic injected, Coinbase, etc.) over WalletConnect so
// users with a wallet extension get the native popup instead of a QR modal.
async function pickInjectedConnector(
  connectors: readonly Connector[],
): Promise<Connector | null> {
  const eligible: Connector[] = [];
  for (const connector of connectors) {
    if (await isPhantomConnector(connector)) continue;
    eligible.push(connector);
  }
  if (eligible.length === 0) return null;

  // Prefer injected-type connectors over walletConnect; ordering within
  // `connectors` already reflects RainbowKit's wallet detection priority.
  const injected = eligible.find((c) => {
    const type = c.type.toLowerCase();
    const id = c.id.toLowerCase();
    return (
      type === "injected" ||
      id === "metamask" ||
      id === "metaMaskSDK".toLowerCase() ||
      id === "coinbasewallet" ||
      id === "coinbasewalletsdk"
    );
  });
  return injected ?? eligible[0];
}

/**
 * Native Ethereum + Solana sign-in buttons that match Google/Discord styling.
 *
 * Click flow:
 *   1. If not connected, open the wallet connect modal.
 *   2. Once connected, auto-trigger the SIWE/SIWS signature.
 *   3. Call onSuccess(result) or onError(err).
 */
export function WalletButtons({
  autoStart,
  auth,
  disabled,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
  loadingProvider,
}: {
  autoStart?: "ethereum" | "solana" | null;
  auth: StewardAuth;
  disabled: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: (result: StewardAuthResult) => void | Promise<void>;
  onError: (error: Error, kind: "ethereum" | "solana") => void;
  onLoadingChange: (kind: "ethereum" | "solana" | null) => void;
  loadingProvider: "ethereum" | "solana" | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <EthereumButton
        autoStart={autoStart === "ethereum"}
        auth={auth}
        disabled={disabled}
        onAutoStartHandled={onAutoStartHandled}
        loading={loadingProvider === "ethereum"}
        onSuccess={onSuccess}
        onError={(err) => onError(err, "ethereum")}
        onLoadingChange={(l) => onLoadingChange(l ? "ethereum" : null)}
      />
      <SolanaButton
        autoStart={autoStart === "solana"}
        auth={auth}
        disabled={disabled}
        onAutoStartHandled={onAutoStartHandled}
        loading={loadingProvider === "solana"}
        onSuccess={onSuccess}
        onError={(err) => onError(err, "solana")}
        onLoadingChange={(l) => onLoadingChange(l ? "solana" : null)}
      />
    </div>
  );
}

// ── Ethereum ────────────────────────────────────────────────────────────────

function EthereumButton({
  autoStart,
  auth,
  disabled,
  loading,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  autoStart: boolean;
  auth: StewardAuth;
  disabled: boolean;
  loading: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: (result: StewardAuthResult) => void | Promise<void>;
  onError: (err: Error) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  const t = useT();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { connectAsync, connectors } = useConnect();
  const { openConnectModal } = useConnectModal();
  // We start a sign flow either from the click (if already connected) or after
  // the user connects via the modal. This ref tracks the "we're waiting for
  // connection to trigger SIWE" intent.
  const pendingSignRef = useRef(false);

  const sign = useCallback(
    async (addr: `0x${string}`) => {
      onLoadingChange(true);
      try {
        const result = await auth.signInWithSIWE(
          addr,
          async (message: string) => {
            return await signMessageAsync({ message });
          },
        );
        await onSuccess(result);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        onError(err);
      } finally {
        onLoadingChange(false);
      }
    },
    [auth, signMessageAsync, onSuccess, onError, onLoadingChange],
  );

  // If click triggered a connect modal, once connection lands, auto-sign.
  useEffect(() => {
    if (pendingSignRef.current && isConnected && address) {
      pendingSignRef.current = false;
      void sign(address);
    }
  }, [isConnected, address, sign]);

  const connectAndSign = useCallback(async () => {
    onLoadingChange(true);
    try {
      const connector = await pickInjectedConnector(connectors);
      if (!connector) {
        // No injected connector available — fall through to the RainbowKit
        // modal (WalletConnect QR etc.).
        pendingSignRef.current = true;
        openConnectModal?.();
        return;
      }
      const { accounts } = await connectAsync({ connector });
      const [account] = accounts;
      if (!account) {
        throw new Error(
          t("cloud.login.wallet.error.noAccount", {
            defaultValue: "No Ethereum account returned by wallet.",
          }),
        );
      }
      await sign(account);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onError(err);
    } finally {
      onLoadingChange(false);
    }
  }, [
    connectAsync,
    connectors,
    openConnectModal,
    onError,
    onLoadingChange,
    sign,
    t,
  ]);

  const handleClick = useCallback(() => {
    if (disabled || loading) return;
    if (isConnected && address) {
      void sign(address);
      return;
    }
    void connectAndSign();
  }, [disabled, loading, isConnected, address, sign, connectAndSign]);

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || disabled || loading) return;
    autoStartedRef.current = true;
    onAutoStartHandled?.();
    handleClick();
  }, [autoStart, disabled, handleClick, loading, onAutoStartHandled]);

  // If the user closes the modal without connecting, we don't have a clean
  // signal from RainbowKit; the next effect-tick just leaves pendingSignRef
  // set until the next connect. That's fine — worst case is a stale flag
  // that fires on a later successful connect.

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center justify-center gap-2 bg-transparent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white hover:text-black disabled:opacity-50"
    >
      {loading ? <Spinner /> : <EvmIconRow />}{" "}
      {t("cloud.login.wallet.evm", { defaultValue: "EVM" })}
    </button>
  );
}

// ── Solana ──────────────────────────────────────────────────────────────────

function SolanaButton({
  autoStart,
  auth,
  disabled,
  loading,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  autoStart: boolean;
  auth: StewardAuth;
  disabled: boolean;
  loading: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: (result: StewardAuthResult) => void | Promise<void>;
  onError: (err: Error) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  const t = useT();
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const pendingSignRef = useRef(false);

  const sign = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      onError(
        new Error(
          t("cloud.login.wallet.error.notSupported", {
            defaultValue:
              "Connected Solana wallet does not support message signing.",
          }),
        ),
      );
      return;
    }
    onLoadingChange(true);
    try {
      const publicKey = wallet.publicKey.toBase58();
      const signMessage = wallet.signMessage;
      const result = await auth.signInWithSolana(
        publicKey,
        async (msg: Uint8Array) => {
          const out = await signMessage(msg);
          if (!out)
            throw new Error(
              t("cloud.login.wallet.error.emptySignature", {
                defaultValue: "Wallet returned an empty signature.",
              }),
            );
          return out;
        },
      );
      await onSuccess(result);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onError(err);
    } finally {
      onLoadingChange(false);
    }
  }, [auth, wallet, onSuccess, onError, onLoadingChange, t]);

  useEffect(() => {
    if (pendingSignRef.current && wallet.connected && wallet.publicKey) {
      pendingSignRef.current = false;
      void sign();
    }
  }, [wallet.connected, wallet.publicKey, sign]);

  const handleClick = useCallback(() => {
    if (disabled || loading) return;
    if (wallet.connected && wallet.publicKey) {
      void sign();
      return;
    }
    pendingSignRef.current = true;
    setVisible(true);
  }, [disabled, loading, wallet.connected, wallet.publicKey, sign, setVisible]);

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || disabled || loading) return;
    autoStartedRef.current = true;
    onAutoStartHandled?.();
    handleClick();
  }, [autoStart, disabled, handleClick, loading, onAutoStartHandled]);

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center justify-center gap-2 bg-transparent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white hover:text-black disabled:opacity-50"
    >
      {loading ? <Spinner /> : <SolanaIcon />}{" "}
      {t("cloud.login.wallet.solana", { defaultValue: "Solana" })}
    </button>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────
//
// Real brand marks via @web3icons/react. `variant="branded"` renders the
// official multi-color logo (not a single-color stencil). Each ships as a
// 24×24 viewBox SVG; we scale to h-4 w-4 to match the button text.

function EvmIconRow() {
  return (
    <span aria-hidden="true" className="flex items-center -space-x-1">
      <NetworkEthereum
        variant="branded"
        size={16}
        className="rounded-full bg-white p-[1px] ring-1 ring-black/20"
      />
      <NetworkBase
        variant="branded"
        size={16}
        className="rounded-full ring-1 ring-black/20"
      />
      <NetworkBinanceSmartChain
        variant="branded"
        size={16}
        className="rounded-full bg-white ring-1 ring-black/20"
      />
    </span>
  );
}

function SolanaIcon() {
  return <TokenSOL variant="branded" size={16} aria-hidden="true" />;
}

function Spinner() {
  return (
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
  );
}
