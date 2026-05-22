import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { StewardAuth, StewardAuthResult } from "@stwd/sdk";
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
  auth,
  disabled,
  onSuccess,
  onError,
  onLoadingChange,
  loadingProvider,
}: {
  auth: StewardAuth;
  disabled: boolean;
  onSuccess: (result: StewardAuthResult) => void | Promise<void>;
  onError: (error: Error, kind: "ethereum" | "solana") => void;
  onLoadingChange: (kind: "ethereum" | "solana" | null) => void;
  loadingProvider: "ethereum" | "solana" | null;
}) {
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      <EthereumButton
        auth={auth}
        disabled={disabled}
        loading={loadingProvider === "ethereum"}
        onSuccess={onSuccess}
        onError={(err) => onError(err, "ethereum")}
        onLoadingChange={(l) => onLoadingChange(l ? "ethereum" : null)}
      />
      <SolanaButton
        auth={auth}
        disabled={disabled}
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
  auth,
  disabled,
  loading,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  auth: StewardAuth;
  disabled: boolean;
  loading: boolean;
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

  // If the user closes the modal without connecting, we don't have a clean
  // signal from RainbowKit; the next effect-tick just leaves pendingSignRef
  // set until the next connect. That's fine — worst case is a stale flag
  // that fires on a later successful connect.

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center justify-center gap-2 border border-white/20 bg-transparent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
    >
      {loading ? <Spinner /> : <EvmIconRow />}{" "}
      {t("cloud.login.wallet.evm", { defaultValue: "EVM" })}
    </button>
  );
}

// ── Solana ──────────────────────────────────────────────────────────────────

function SolanaButton({
  auth,
  disabled,
  loading,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  auth: StewardAuth;
  disabled: boolean;
  loading: boolean;
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

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center justify-center gap-2 border border-white/20 bg-transparent px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-white/10 disabled:opacity-50"
    >
      {loading ? <Spinner /> : <SolanaIcon />}{" "}
      {t("cloud.login.wallet.solana", { defaultValue: "Solana" })}
    </button>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function EvmIconRow() {
  return (
    <span aria-hidden="true" className="flex items-center -space-x-1">
      <EthereumIcon />
      <BaseIcon />
      <BnbIcon />
    </span>
  );
}

function EthereumIcon() {
  return (
    <svg
      className="h-4 w-4 rounded-full bg-white p-[1px] ring-1 ring-black/20"
      aria-hidden="true"
      viewBox="0 0 256 417"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path
        fill="#343434"
        d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z"
      />
      <path fill="#8C8C8C" d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
      <path
        fill="#3C3C3B"
        d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z"
      />
      <path fill="#8C8C8C" d="M127.962 416.905v-104.72L0 236.585z" />
      <path fill="#141414" d="M127.961 287.958l127.96-75.637-127.96-58.162z" />
      <path fill="#393939" d="M0 212.32l127.96 75.638v-133.8z" />
    </svg>
  );
}

function BaseIcon() {
  return (
    <svg
      className="h-4 w-4 rounded-full ring-1 ring-black/20"
      aria-hidden="true"
      viewBox="0 0 111 111"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="55.5" cy="55.5" r="55.5" fill="#0052FF" />
      <path
        fill="#fff"
        d="M54.9 91.5c19.9 0 36-16.1 36-36s-16.1-36-36-36c-18.9 0-34.4 14.5-35.9 33h47.5v6H19c1.5 18.5 17 33 35.9 33Z"
      />
    </svg>
  );
}

function BnbIcon() {
  // BNB Chain mark: yellow disc with the four-diamond + center-diamond
  // pattern in white. Matches https://bnbchain.org brand guidelines and
  // the Wikimedia reference SVG. Previously the disc was white with
  // yellow diamonds, which is not how the mark is rendered anywhere.
  return (
    <svg
      className="h-4 w-4 rounded-full ring-1 ring-black/20"
      aria-hidden="true"
      viewBox="0 0 32 32"
      xmlns="http://www.w3.org/2000/svg"
    >
      <circle cx="16" cy="16" r="16" fill="#F0B90B" />
      <path
        fill="#FFFFFF"
        d="M16 4 11.3 8.7 16 13.4l4.7-4.7L16 4Zm-7.3 7.3L4 16l4.7 4.7L13.4 16 8.7 11.3Zm14.6 0L18.6 16l4.7 4.7L28 16l-4.7-4.7ZM16 18.6l-4.7 4.7L16 28l4.7-4.7L16 18.6Zm0-5.2L13.4 16 16 18.6 18.6 16 16 13.4Z"
      />
    </svg>
  );
}

function SolanaIcon() {
  return (
    <svg
      className="h-4 w-4"
      aria-hidden="true"
      viewBox="0 0 128 128"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="sol-a" x1="0%" x2="100%" y1="50%" y2="50%">
          <stop offset="0%" stopColor="#9945FF" />
          <stop offset="100%" stopColor="#14F195" />
        </linearGradient>
      </defs>
      <path
        fill="url(#sol-a)"
        d="M23.9 87.3c.8-.8 1.9-1.3 3.1-1.3h97.8c1.9 0 2.9 2.3 1.5 3.7l-19.3 19.3c-.8.8-1.9 1.3-3.1 1.3H5.1c-1.9 0-2.9-2.3-1.5-3.7zm0-72.1c.8-.8 1.9-1.3 3.1-1.3h97.8c1.9 0 2.9 2.3 1.5 3.7L107.1 36.9c-.8.8-1.9 1.3-3.1 1.3H5.1c-1.9 0-2.9-2.3-1.5-3.7zm80.3 36c-.8-.8-1.9-1.3-3.1-1.3H3.3c-1.9 0-2.9 2.3-1.5 3.7l19.3 19.3c.8.8 1.9 1.3 3.1 1.3h97.8c1.9 0 2.9-2.3 1.5-3.7z"
      />
    </svg>
  );
}

function Spinner() {
  return (
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
  );
}
