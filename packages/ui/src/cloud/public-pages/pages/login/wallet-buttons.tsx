/**
 * Native Ethereum + Solana sign-in buttons for the Steward login section.
 *
 * Bounded port of `cloud-frontend@4056e0e868`'s wallet-buttons (#the wallet
 * branch dropped in the cloud-frontend → @elizaos/ui fold). Changes from the
 * original: i18n comes from CloudI18nProvider, and the @web3icons brand marks
 * are dropped for text-only buttons (the console is black-and-white; color is
 * reserved for meaning).
 *
 * Click flow:
 *   1. If not connected, open the wallet connect modal (native EIP-1193 /
 *      injected connector preferred over the RainbowKit QR modal).
 *   2. Once connected, auto-trigger the SIWE/SIWS signature.
 *   3. Call onSuccess(result) or onError(err).
 *
 * Must render inside `StewardWalletProviders` (wagmi + RainbowKit + Solana
 * adapter contexts — shared with the billing crypto top-up).
 */

import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import type {
  StewardAuth,
  StewardAuthResult,
  StewardMfaRequiredResult,
} from "@stwd/sdk";
import { useCallback, useEffect, useRef } from "react";
import { type Connector, useAccount, useConnect, useSignMessage } from "wagmi";
import { useCloudT } from "../../../shell/CloudI18nProvider";

type HexAddress = `0x${string}`;

interface Eip1193Provider {
  isPhantom?: boolean;
  request(args: {
    method: "eth_accounts" | "eth_requestAccounts";
  }): Promise<readonly string[] | null>;
  request(args: {
    method: "personal_sign";
    params: readonly [`0x${string}`, HexAddress];
  }): Promise<string>;
}

function getWindowEthereumProvider(): Eip1193Provider | null {
  if (typeof window === "undefined") return null;
  const ethereum = (window as Window & { ethereum?: Eip1193Provider }).ethereum;
  if (!ethereum || typeof ethereum.request !== "function") return null;
  if (ethereum.isPhantom === true) return null;
  return ethereum;
}

function isHexAddress(value: string | undefined): value is HexAddress {
  return /^0x[a-fA-F0-9]{40}$/.test(value ?? "");
}

// Wallet sign-in returns `StewardAuthResult | StewardMfaRequiredResult`.
// There is no MFA-continuation UI in this login surface, so narrow on the
// `mfaRequired` discriminant and surface a clear error instead of forwarding
// an MFA challenge to onSuccess as if it carried tokens.
function requireCompletedAuth(
  result: StewardAuthResult | StewardMfaRequiredResult,
): StewardAuthResult {
  if ("mfaRequired" in result) {
    throw new Error("MFA required — not yet supported in this client.");
  }
  return result;
}

async function requestEip1193Account(
  provider: Eip1193Provider,
): Promise<HexAddress | null> {
  const existingAccounts = await provider.request({ method: "eth_accounts" });
  const [existingAccount] = existingAccounts ?? [];
  if (isHexAddress(existingAccount)) return existingAccount;

  const requestedAccounts = await provider.request({
    method: "eth_requestAccounts",
  });
  const [requestedAccount] = requestedAccounts ?? [];
  return isHexAddress(requestedAccount) ? requestedAccount : null;
}

function stringToHex(value: string): `0x${string}` {
  let hex = "";
  for (const byte of new TextEncoder().encode(value)) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return `0x${hex}`;
}

async function personalSign(
  provider: Eip1193Provider,
  address: HexAddress,
  message: string,
): Promise<string> {
  const signature = await provider.request({
    method: "personal_sign",
    params: [stringToHex(message), address],
  });
  if (!signature.startsWith("0x")) {
    throw new Error("Wallet returned an invalid Ethereum signature.");
  }
  return signature;
}

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
    // error-policy:J6 best-effort provider probe. A connector that can't
    // surface its provider yet is treated as non-Phantom; the real failure (if
    // any) surfaces at the downstream connect() the caller runs regardless.
    return false;
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
  const t = useCloudT();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { connectAsync, connectors } = useConnect();
  const { openConnectModal } = useConnectModal();
  // We start a sign flow either from the click (if already connected) or after
  // the user connects via the modal. This ref tracks the "we're waiting for
  // connection to trigger SIWE" intent.
  const pendingSignRef = useRef(false);

  const signWith = useCallback(
    async (
      addr: HexAddress,
      signMessage: (message: string) => Promise<string>,
    ) => {
      onLoadingChange(true);
      try {
        const result = requireCompletedAuth(
          await auth.signInWithSIWE(addr, signMessage),
        );
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

  const sign = useCallback(
    async (addr: HexAddress) => {
      await signWith(addr, async (message: string) => {
        return await signMessageAsync({ message });
      });
    },
    [signMessageAsync, signWith],
  );

  const signWithEip1193 = useCallback(
    async (provider: Eip1193Provider, addr: HexAddress) => {
      await signWith(addr, async (message: string) => {
        return await personalSign(provider, addr, message);
      });
    },
    [signWith],
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
      const provider = getWindowEthereumProvider();
      if (provider) {
        const account = await requestEip1193Account(provider);
        if (account) {
          await signWithEip1193(provider, account);
          return;
        }
      }

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
    signWithEip1193,
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
      className="flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
    >
      {loading && <Spinner />}
      {t("cloud.login.wallet.evm", { defaultValue: "EVM wallet" })}
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
  const t = useCloudT();
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
      const result = requireCompletedAuth(
        await auth.signInWithSolana(publicKey, async (msg: Uint8Array) => {
          const out = await signMessage(msg);
          if (!out)
            throw new Error(
              t("cloud.login.wallet.error.emptySignature", {
                defaultValue: "Wallet returned an empty signature.",
              }),
            );
          return out;
        }),
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
      className="flex min-h-touch items-center justify-center gap-2 rounded-md border border-border-strong bg-bg-elevated px-4 py-2.5 text-sm font-semibold text-txt transition-[background-color,border-color,transform] hover:border-border-hover hover:bg-bg-hover active:scale-[0.99] disabled:pointer-events-none disabled:opacity-50"
    >
      {loading && <Spinner />}
      {t("cloud.login.wallet.solana", { defaultValue: "Solana wallet" })}
    </button>
  );
}

function Spinner() {
  return (
    <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent opacity-70 motion-reduce:animate-none" />
  );
}
