/**
 * Ethereum and Solana sign-in retain the original login authority across
 * wallet connection, signature and verified Cloud session completion.
 * Human prompts never hold the origin-wide lock; each subsequent step checks
 * the original attempt. Dismissed or departed intents cannot auto-sign a later
 * unrelated connection. Already-dispatched extension actions cannot be undone.
 *
 * The discovered SIWE/SIWS capabilities remain authoritative after this lazy
 * stack mounts, so an unannounced chain never renders a sign-in control.
 *
 * Must render inside `StewardWalletProviders` (wagmi + RainbowKit + Solana
 * adapter contexts — shared with the billing crypto top-up).
 */

import type {
  LoginAuth,
  LoginAuthResult,
  LoginMfaRequiredResult,
} from "@elizaos/login";
import {
  StewardSessionAuthorityError,
  type StewardSessionAuthorityWorkContext,
} from "@elizaos/shared/steward-session-client";
import { useConnectModal } from "@rainbow-me/rainbowkit";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useCallback, useEffect, useRef } from "react";
import { type Connector, useAccount, useConnect, useSignMessage } from "wagmi";
import { Button } from "../../../../components/ui/button";
import { Spinner } from "../../../../components/ui/spinner";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import {
  createSignInAttempt,
  type SignInAttempt,
  withSignInAttempt,
} from "./sign-in-attempt";

type WalletSuccess = (
  result: LoginAuthResult,
  authority: StewardSessionAuthorityWorkContext,
) => void | Promise<void>;
type StartWalletAttempt = (initial?: SignInAttempt | null) => SignInAttempt;
type PendingWalletConnection = { attempt: SignInAttempt; modalSeen: boolean };

function walletSignInError(
  error: unknown,
  t: ReturnType<typeof useCloudT>,
): Error {
  if (error instanceof StewardSessionAuthorityError)
    return new Error(
      t("cloud.login.sessionChanged", {
        defaultValue:
          "Your session changed during sign-in. Please sign in again below.",
      }),
    );
  return error instanceof Error ? error : new Error(String(error));
}

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
  result: LoginAuthResult | LoginMfaRequiredResult,
): LoginAuthResult {
  if ("mfaRequired" in result) {
    throw new Error("MFA required — not yet supported in this client.");
  }
  return result;
}

async function requestEip1193Account(
  provider: Eip1193Provider,
  attempt: SignInAttempt,
): Promise<HexAddress | null> {
  const existingAccounts = await provider.request({ method: "eth_accounts" });
  await withSignInAttempt(attempt, async () => {});
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
  initialAttempt,
  onAttemptStart,
  auth,
  disabled,
  siwe = false,
  siws = false,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
  loadingProvider,
}: {
  autoStart?: "ethereum" | "solana" | null;
  initialAttempt?: SignInAttempt | null;
  onAttemptStart?: (kind: "ethereum" | "solana") => SignInAttempt;
  auth: LoginAuth;
  disabled: boolean;
  siwe?: boolean;
  siws?: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: WalletSuccess;
  onError: (error: Error, kind: "ethereum" | "solana") => void;
  onLoadingChange: (kind: "ethereum" | "solana" | null) => void;
  loadingProvider: "ethereum" | "solana" | null;
}) {
  const activeAttemptRef = useRef<SignInAttempt | null>(null);
  const loadingCallbackRef = useRef(onLoadingChange);
  loadingCallbackRef.current = onLoadingChange;
  useEffect(() => {
    const leavePage = () => {
      activeAttemptRef.current?.controller.abort();
      loadingCallbackRef.current(null);
    };
    window.addEventListener("pagehide", leavePage);
    return () => {
      window.removeEventListener("pagehide", leavePage);
      activeAttemptRef.current?.controller.abort();
    };
  }, []);
  const begin = useCallback(
    (kind: "ethereum" | "solana", initial?: SignInAttempt | null) => {
      if (activeAttemptRef.current !== initial)
        activeAttemptRef.current?.controller.abort();
      const attempt =
        initial ?? onAttemptStart?.(kind) ?? createSignInAttempt();
      activeAttemptRef.current = attempt;
      return attempt;
    },
    [onAttemptStart],
  );
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {siwe && (
        <EthereumButton
          autoStart={autoStart === "ethereum"}
          initialAttempt={initialAttempt}
          onAttemptStart={(initial) => begin("ethereum", initial)}
          auth={auth}
          disabled={disabled}
          onAutoStartHandled={onAutoStartHandled}
          loading={loadingProvider === "ethereum"}
          onSuccess={onSuccess}
          onError={(err) => onError(err, "ethereum")}
          onLoadingChange={(l) => onLoadingChange(l ? "ethereum" : null)}
        />
      )}
      {siws && (
        <SolanaButton
          autoStart={autoStart === "solana"}
          initialAttempt={initialAttempt}
          onAttemptStart={(initial) => begin("solana", initial)}
          auth={auth}
          disabled={disabled}
          onAutoStartHandled={onAutoStartHandled}
          loading={loadingProvider === "solana"}
          onSuccess={onSuccess}
          onError={(err) => onError(err, "solana")}
          onLoadingChange={(l) => onLoadingChange(l ? "solana" : null)}
        />
      )}
    </div>
  );
}

// ── Ethereum ────────────────────────────────────────────────────────────────

function EthereumButton({
  autoStart,
  initialAttempt,
  onAttemptStart,
  auth,
  disabled,
  loading,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  autoStart: boolean;
  initialAttempt?: SignInAttempt | null;
  onAttemptStart: StartWalletAttempt;
  auth: LoginAuth;
  disabled: boolean;
  loading: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: WalletSuccess;
  onError: (err: Error) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  const t = useCloudT();
  const { address, isConnected, isConnecting } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { connectAsync, connectors } = useConnect();
  const { openConnectModal, connectModalOpen } = useConnectModal();
  // We start a sign flow either from the click (if already connected) or after
  // the user connects via the modal. This ref tracks the "we're waiting for
  // connection to trigger SIWE" intent.
  const pendingSignRef = useRef<PendingWalletConnection | null>(null);
  const attemptRef = useRef<SignInAttempt | null>(null);
  useEffect(() => () => attemptRef.current?.controller.abort(), []);
  const finish = useCallback(
    (attempt: SignInAttempt) => {
      if (attemptRef.current !== attempt) return;
      attemptRef.current = null;
      if (!attempt.controller.signal.aborted) onLoadingChange(false);
      attempt.controller.abort();
    },
    [onLoadingChange],
  );

  const signWith = useCallback(
    async (
      addr: HexAddress,
      signMessage: (message: string) => Promise<string>,
      attempt: SignInAttempt,
    ) => {
      if (attempt.controller.signal.aborted || attemptRef.current !== attempt)
        return;
      onLoadingChange(true);
      try {
        await withSignInAttempt(attempt, async () => {});
        const result = requireCompletedAuth(
          await auth.signInWithSIWE(addr, async (message) => {
            await withSignInAttempt(attempt, async () => {});
            const signature = await signMessage(message);
            await withSignInAttempt(attempt, async () => {});
            return signature;
          }),
        );
        await withSignInAttempt(attempt, async (authority) => {
          await onSuccess(result, authority);
        });
      } catch (e) {
        // error-policy:J4 Superseded wallet results stay nonterminal with explicit retry.
        if (
          !attempt.controller.signal.aborted &&
          attemptRef.current === attempt
        )
          onError(walletSignInError(e, t));
      } finally {
        finish(attempt);
      }
    },
    [auth, onSuccess, onError, onLoadingChange, finish, t],
  );

  const sign = useCallback(
    async (addr: HexAddress, attempt: SignInAttempt) => {
      await signWith(
        addr,
        async (message: string) => {
          return await signMessageAsync({ message });
        },
        attempt,
      );
    },
    [signMessageAsync, signWith],
  );

  const signWithEip1193 = useCallback(
    async (
      provider: Eip1193Provider,
      addr: HexAddress,
      attempt: SignInAttempt,
    ) => {
      await signWith(
        addr,
        async (message: string) => {
          return await personalSign(provider, addr, message);
        },
        attempt,
      );
    },
    [signWith],
  );

  // If click triggered a connect modal, once connection lands, auto-sign.
  useEffect(() => {
    const pending = pendingSignRef.current;
    if (!pending) return;
    if (pending.attempt.controller.signal.aborted) {
      pendingSignRef.current = null;
      return;
    }
    if (isConnected && address) {
      pendingSignRef.current = null;
      void sign(address, pending.attempt);
      return;
    }
    if (connectModalOpen) pending.modalSeen = true;
    else if (pending.modalSeen && !isConnecting) {
      pendingSignRef.current = null;
      onError(
        new Error(
          t("cloud.login.wallet.error.cancelled", {
            defaultValue:
              "Wallet connection was cancelled. Choose your wallet again to retry.",
          }),
        ),
      );
      finish(pending.attempt);
    }
  }, [
    isConnected,
    isConnecting,
    address,
    sign,
    connectModalOpen,
    onError,
    finish,
    t,
  ]);

  const connectAndSign = useCallback(
    async (attempt: SignInAttempt) => {
      onLoadingChange(true);
      try {
        await withSignInAttempt(attempt, async () => {});
        const provider = getWindowEthereumProvider();
        if (provider) {
          const account = await requestEip1193Account(provider, attempt);
          if (account) {
            await signWithEip1193(provider, account, attempt);
            return;
          }
        }

        const connector = await pickInjectedConnector(connectors);
        await withSignInAttempt(attempt, async () => {});
        if (!connector) {
          // No injected connector available — fall through to the RainbowKit
          // modal (WalletConnect QR etc.).
          if (!openConnectModal)
            throw new Error(
              t("cloud.login.wallet.error.unavailable", {
                defaultValue:
                  "Wallet connection is unavailable. Please try again.",
              }),
            );
          pendingSignRef.current = { attempt, modalSeen: false };
          openConnectModal();
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
        await sign(account, attempt);
      } catch (e) {
        // error-policy:J4 Connection failures do not authorize a future unrelated wallet connection.
        if (
          !attempt.controller.signal.aborted &&
          attemptRef.current === attempt
        )
          onError(walletSignInError(e, t));
      } finally {
        if (pendingSignRef.current?.attempt === attempt) {
          if (!attempt.controller.signal.aborted) onLoadingChange(false);
        } else finish(attempt);
      }
    },
    [
      connectAsync,
      connectors,
      openConnectModal,
      onError,
      onLoadingChange,
      sign,
      signWithEip1193,
      t,
      finish,
    ],
  );

  const handleClick = useCallback(
    (initial?: SignInAttempt | null) => {
      if (disabled || loading || initial?.controller.signal.aborted) return;
      const attempt = onAttemptStart(initial);
      attemptRef.current = attempt;
      pendingSignRef.current = null;
      if (isConnected && address) {
        void sign(address, attempt);
        return;
      }
      void connectAndSign(attempt);
    },
    [
      disabled,
      loading,
      isConnected,
      address,
      sign,
      connectAndSign,
      onAttemptStart,
    ],
  );

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || disabled || loading) return;
    // Let an abandoned/StrictMode effect clean up before starting a human
    // prompt. Only the committed effect consumes the original lazy intent.
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      autoStartedRef.current = true;
      onAutoStartHandled?.();
      handleClick(initialAttempt);
    });
    return () => {
      current = false;
    };
  }, [
    autoStart,
    disabled,
    handleClick,
    initialAttempt,
    loading,
    onAutoStartHandled,
  ]);

  return (
    <Button
      variant="outlineMuted"
      size="touch"
      type="button"
      onClick={() => handleClick()}
      disabled={disabled}
      className="hosted-signin-focus-emphasis"
    >
      {loading && <Spinner />}
      {t("cloud.login.wallet.evm", { defaultValue: "EVM wallet" })}
    </Button>
  );
}

// ── Solana ──────────────────────────────────────────────────────────────────

function SolanaButton({
  autoStart,
  initialAttempt,
  onAttemptStart,
  auth,
  disabled,
  loading,
  onAutoStartHandled,
  onSuccess,
  onError,
  onLoadingChange,
}: {
  autoStart: boolean;
  initialAttempt?: SignInAttempt | null;
  onAttemptStart: StartWalletAttempt;
  auth: LoginAuth;
  disabled: boolean;
  loading: boolean;
  onAutoStartHandled?: () => void;
  onSuccess: WalletSuccess;
  onError: (err: Error) => void;
  onLoadingChange: (loading: boolean) => void;
}) {
  const t = useCloudT();
  const wallet = useWallet();
  const { setVisible, visible } = useWalletModal();
  const pendingSignRef = useRef<PendingWalletConnection | null>(null);
  const attemptRef = useRef<SignInAttempt | null>(null);
  useEffect(() => () => attemptRef.current?.controller.abort(), []);
  const finish = useCallback(
    (attempt: SignInAttempt) => {
      if (attemptRef.current !== attempt) return;
      attemptRef.current = null;
      if (!attempt.controller.signal.aborted) onLoadingChange(false);
      attempt.controller.abort();
    },
    [onLoadingChange],
  );

  const sign = useCallback(
    async (attempt: SignInAttempt) => {
      if (attempt.controller.signal.aborted || attemptRef.current !== attempt)
        return;
      if (!wallet.publicKey || !wallet.signMessage) {
        onError(
          new Error(
            t("cloud.login.wallet.error.notSupported", {
              defaultValue:
                "Connected Solana wallet does not support message signing.",
            }),
          ),
        );
        finish(attempt);
        return;
      }
      onLoadingChange(true);
      try {
        await withSignInAttempt(attempt, async () => {});
        const publicKey = wallet.publicKey.toBase58();
        const signMessage = wallet.signMessage;
        const result = requireCompletedAuth(
          await auth.signInWithSolana(publicKey, async (msg: Uint8Array) => {
            await withSignInAttempt(attempt, async () => {});
            const out = await signMessage(msg);
            await withSignInAttempt(attempt, async () => {});
            if (!out)
              throw new Error(
                t("cloud.login.wallet.error.emptySignature", {
                  defaultValue: "Wallet returned an empty signature.",
                }),
              );
            return out;
          }),
        );
        await withSignInAttempt(attempt, async (authority) => {
          await onSuccess(result, authority);
        });
      } catch (e) {
        // error-policy:J4 Superseded wallet results stay nonterminal with explicit retry.
        if (
          !attempt.controller.signal.aborted &&
          attemptRef.current === attempt
        )
          onError(walletSignInError(e, t));
      } finally {
        finish(attempt);
      }
    },
    [auth, wallet, onSuccess, onError, onLoadingChange, t, finish],
  );

  useEffect(() => {
    const pending = pendingSignRef.current;
    if (!pending) return;
    if (pending.attempt.controller.signal.aborted) {
      pendingSignRef.current = null;
      return;
    }
    if (wallet.connected && wallet.publicKey) {
      pendingSignRef.current = null;
      void sign(pending.attempt);
      return;
    }
    if (visible) pending.modalSeen = true;
    else if (pending.modalSeen && !wallet.connecting) {
      pendingSignRef.current = null;
      onError(
        new Error(
          t("cloud.login.wallet.error.cancelled", {
            defaultValue:
              "Wallet connection was cancelled. Choose your wallet again to retry.",
          }),
        ),
      );
      finish(pending.attempt);
    }
  }, [
    wallet.connected,
    wallet.connecting,
    wallet.publicKey,
    visible,
    sign,
    onError,
    finish,
    t,
  ]);

  const handleClick = useCallback(
    (initial?: SignInAttempt | null) => {
      if (disabled || loading || initial?.controller.signal.aborted) return;
      const attempt = onAttemptStart(initial);
      attemptRef.current = attempt;
      pendingSignRef.current = null;
      if (wallet.connected && wallet.publicKey) {
        void sign(attempt);
        return;
      }
      pendingSignRef.current = { attempt, modalSeen: false };
      setVisible(true);
    },
    [
      disabled,
      loading,
      wallet.connected,
      wallet.publicKey,
      sign,
      setVisible,
      onAttemptStart,
    ],
  );

  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (!autoStart || autoStartedRef.current || disabled || loading) return;
    // Only the committed effect consumes the original lazy intent.
    let current = true;
    queueMicrotask(() => {
      if (!current) return;
      autoStartedRef.current = true;
      onAutoStartHandled?.();
      handleClick(initialAttempt);
    });
    return () => {
      current = false;
    };
  }, [
    autoStart,
    disabled,
    handleClick,
    initialAttempt,
    loading,
    onAutoStartHandled,
  ]);

  return (
    <Button
      variant="outlineMuted"
      size="touch"
      type="button"
      onClick={() => handleClick()}
      disabled={disabled}
      className="hosted-signin-focus-emphasis"
    >
      {loading && <Spinner />}
      {t("cloud.login.wallet.solana", { defaultValue: "Solana wallet" })}
    </Button>
  );
}
