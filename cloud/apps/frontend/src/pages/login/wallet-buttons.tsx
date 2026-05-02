import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type { StewardAuth, StewardAuthResult } from "@stwd/sdk";
import { useCallback, useEffect, useRef } from "react";
import { useAccount, useSignMessage } from "wagmi";

interface EthereumProvider {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
}

function isEthereumProvider(value: unknown): value is EthereumProvider {
  return (
    value !== null &&
    typeof value === "object" &&
    "request" in value &&
    typeof Reflect.get(value, "request") === "function"
  );
}

function getInjectedEthereumProvider(): EthereumProvider | null {
  if (typeof window === "undefined") return null;
  const ethereum = Reflect.get(window, "ethereum") as unknown;
  if (isEthereumProvider(ethereum)) return ethereum;
  const providers =
    ethereum !== null &&
    typeof ethereum === "object" &&
    "providers" in ethereum &&
    Array.isArray(ethereum.providers)
      ? ethereum.providers
      : undefined;
  return providers?.find(isEthereumProvider) ?? null;
}

function toPersonalSignHex(message: string): `0x${string}` {
  const bytes = new TextEncoder().encode(message);
  const hex = Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `0x${hex}`;
}

function getFirstEvmAccount(result: unknown): `0x${string}` | null {
  if (!Array.isArray(result)) return null;
  const [account] = result;
  if (typeof account !== "string") return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(account)) return null;
  return account as `0x${string}`;
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
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { openConnectModal } = useConnectModal();
  // We start a sign flow either from the click (if already connected) or after
  // the user connects via the modal. This ref tracks the "we're waiting for
  // connection to trigger SIWE" intent.
  const pendingSignRef = useRef(false);

  const sign = useCallback(
    async (addr: `0x${string}`) => {
      onLoadingChange(true);
      try {
        const result = await auth.signInWithSIWE(addr, async (message: string) => {
          return await signMessageAsync({ message });
        });
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

  const signWithInjectedProvider = useCallback(
    async (provider: EthereumProvider) => {
      onLoadingChange(true);
      try {
        const accounts = await provider.request({ method: "eth_requestAccounts" });
        const account = getFirstEvmAccount(accounts);
        if (!account) {
          throw new Error("No Ethereum account returned by wallet.");
        }

        const result = await auth.signInWithSIWE(account, async (message: string) => {
          const signature = await provider.request({
            method: "personal_sign",
            params: [toPersonalSignHex(message), account],
          });
          if (typeof signature !== "string" || !signature.startsWith("0x")) {
            throw new Error("Wallet returned an invalid signature.");
          }
          return signature;
        });
        await onSuccess(result);
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        onError(err);
      } finally {
        onLoadingChange(false);
      }
    },
    [auth, onSuccess, onError, onLoadingChange],
  );

  // If click triggered a connect modal, once connection lands, auto-sign.
  useEffect(() => {
    if (pendingSignRef.current && isConnected && address) {
      pendingSignRef.current = false;
      void sign(address);
    }
  }, [isConnected, address, sign]);

  const handleClick = useCallback(() => {
    if (disabled || loading) return;
    if (isConnected && address) {
      void sign(address);
      return;
    }
    const injectedProvider = getInjectedEthereumProvider();
    if (injectedProvider) {
      pendingSignRef.current = false;
      void signWithInjectedProvider(injectedProvider);
      return;
    }
    // Not connected: open the modal and flag for auto-sign once connected.
    pendingSignRef.current = true;
    openConnectModal?.();
  }, [disabled, loading, isConnected, address, sign, signWithInjectedProvider, openConnectModal]);

  // If the user closes the modal without connecting, we don't have a clean
  // signal from RainbowKit; the next effect-tick just leaves pendingSignRef
  // set until the next connect. That's fine — worst case is a stale flag
  // that fires on a later successful connect.

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={disabled}
      className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-50"
    >
      {loading ? <Spinner /> : <EthereumIcon />} Ethereum
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
  const wallet = useWallet();
  const { setVisible } = useWalletModal();
  const pendingSignRef = useRef(false);

  const sign = useCallback(async () => {
    if (!wallet.publicKey || !wallet.signMessage) {
      onError(new Error("Connected Solana wallet does not support message signing."));
      return;
    }
    onLoadingChange(true);
    try {
      const publicKey = wallet.publicKey.toBase58();
      const signMessage = wallet.signMessage;
      const result = await auth.signInWithSolana(publicKey, async (msg: Uint8Array) => {
        const out = await signMessage(msg);
        if (!out) throw new Error("Wallet returned an empty signature.");
        return out;
      });
      await onSuccess(result);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      onError(err);
    } finally {
      onLoadingChange(false);
    }
  }, [auth, wallet, onSuccess, onError, onLoadingChange]);

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
      className="flex items-center justify-center gap-2 rounded-lg border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition-colors hover:bg-white/10 disabled:opacity-50"
    >
      {loading ? <Spinner /> : <SolanaIcon />} Solana
    </button>
  );
}

// ── Icons ───────────────────────────────────────────────────────────────────

function EthereumIcon() {
  return (
    <svg
      className="h-4 w-4"
      viewBox="0 0 256 417"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
    >
      <path d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" fillOpacity=".7" />
      <path d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
      <path d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.6L256 236.587z" fillOpacity=".7" />
      <path d="M127.962 416.905v-104.72L0 236.585z" />
      <path d="M127.961 287.958l127.96-75.637-127.96-58.162z" fillOpacity=".45" />
      <path d="M0 212.32l127.96 75.638v-133.8z" fillOpacity=".85" />
    </svg>
  );
}

function SolanaIcon() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 128 128" xmlns="http://www.w3.org/2000/svg">
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
