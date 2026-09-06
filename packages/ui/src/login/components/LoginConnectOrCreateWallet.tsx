/** Connects an external wallet or provisions a user wallet after authentication. */
import type {
  LoginAuthResult,
  LoginClient,
  LoginMfaRequiredResult,
  UserWalletCreateResult,
} from "@elizaos/login";
import { useCallback, useRef, useState } from "react";
import { Button } from "../../components/ui/button";
import { useAuth } from "../hooks/useAuth.js";
import { useLogin } from "../hooks/useLogin.js";
import type { WalletChains, WalletLoginClassOverrides } from "./WalletLogin.js";
import { cx, WalletLogin } from "./WalletLogin.js";

export interface LoginConnectOrCreateWalletProps {
  chains?: WalletChains;
  className?: string;
  classes?: WalletLoginClassOverrides & {
    embeddedButton?: string;
    embeddedStatus?: string;
    onboardingStatus?: string;
  };
  showExternalWallets?: boolean;
  showEmbeddedWallet?: boolean;
  embeddedLabel?: string;
  embeddedBusyLabel?: string;
  embeddedSignedOutLabel?: string;
  embeddedAuthRequiredLabel?: string;
  evmLabel?: string;
  solanaLabel?: string;
  evmSignLabel?: (walletName: string | undefined) => string;
  solanaSignLabel?: (walletName: string | undefined) => string;
  onExternalWallet?: (
    result: LoginAuthResult | LoginMfaRequiredResult,
    kind: "evm" | "solana",
  ) => void;
  onEmbeddedWallet?: (result: UserWalletCreateResult) => void;
  onAuthRequired?: (source: "embedded") => void | Promise<void>;
  onError?: (error: Error, source: "embedded" | "evm" | "solana") => void;
}

export interface EmbeddedWalletActionState {
  disabled: boolean;
  label: string;
  requiresAuth: boolean;
}

export type EmbeddedWalletLifecycleState = "created" | "connected" | "restored";

export interface EmbeddedWalletDisplayState {
  state: EmbeddedWalletLifecycleState;
  label: string;
  walletAddress: string;
  walletIndex?: number;
}

type WalletResultWithMetadata = UserWalletCreateResult & {
  claimed?: boolean;
  existing?: boolean;
  isNew?: boolean;
  restoredExisting?: boolean;
};

export async function provisionEmbeddedWalletFallback(
  client: Pick<LoginClient, "provisionUserWallet">,
  isAuthenticated: boolean,
): Promise<UserWalletCreateResult> {
  if (!isAuthenticated) {
    throw new Error("sign in before creating an embedded wallet");
  }
  return client.provisionUserWallet();
}

export function getEmbeddedWalletActionState({
  isAuthenticated,
  isCreating,
  embeddedLabel,
  embeddedBusyLabel,
  embeddedSignedOutLabel,
  embeddedAuthRequiredLabel,
  embeddedReadyLabel = "wallet ready",
  hasAuthRequiredHandler,
  hasEmbeddedWallet = false,
}: {
  isAuthenticated: boolean;
  isCreating: boolean;
  embeddedLabel: string;
  embeddedBusyLabel: string;
  embeddedSignedOutLabel: string;
  embeddedAuthRequiredLabel: string;
  embeddedReadyLabel?: string;
  hasAuthRequiredHandler: boolean;
  hasEmbeddedWallet?: boolean;
}): EmbeddedWalletActionState {
  if (hasEmbeddedWallet) {
    return {
      disabled: true,
      label: embeddedReadyLabel,
      requiresAuth: false,
    };
  }
  if (isAuthenticated) {
    return {
      disabled: isCreating,
      label: isCreating ? embeddedBusyLabel : embeddedLabel,
      requiresAuth: false,
    };
  }
  return {
    disabled: !hasAuthRequiredHandler,
    label: hasAuthRequiredHandler
      ? embeddedAuthRequiredLabel
      : embeddedSignedOutLabel,
    requiresAuth: true,
  };
}

export function getEmbeddedWalletDisplayState(
  result: UserWalletCreateResult | null,
): EmbeddedWalletDisplayState | null {
  if (!result) return null;
  const metadata = result as WalletResultWithMetadata;
  let state: EmbeddedWalletLifecycleState = "created";
  if (metadata.restoredExisting !== undefined) {
    state = "restored";
  } else if (
    metadata.claimed ||
    metadata.existing ||
    metadata.isNew === false
  ) {
    state = "connected";
  }
  const indexLabel =
    typeof result.walletIndex === "number"
      ? ` at wallet index ${result.walletIndex}`
      : "";
  const label =
    state === "restored"
      ? `wallet restored${indexLabel}`
      : state === "connected"
        ? `wallet connected${indexLabel}`
        : `wallet created${indexLabel}`;
  return {
    state,
    label,
    walletAddress: result.walletAddress,
    walletIndex: result.walletIndex,
  };
}

/**
 * Privy-style wallet choice surface for browser apps.
 *
 * External wallets use SIWE/SIWS through the existing wallet panels. Embedded
 * wallet fallback uses the authenticated user's session and never attempts to
 * call platform-key-only connect-or-create routes from browser code.
 */
export function LoginConnectOrCreateWallet({
  chains = "both",
  className,
  classes,
  showExternalWallets = true,
  showEmbeddedWallet = true,
  embeddedLabel = "create embedded wallet",
  embeddedBusyLabel = "creating wallet",
  embeddedSignedOutLabel = "sign in to create wallet",
  embeddedAuthRequiredLabel = embeddedSignedOutLabel,
  evmLabel,
  solanaLabel,
  evmSignLabel,
  solanaSignLabel,
  onExternalWallet,
  onEmbeddedWallet,
  onAuthRequired,
  onError,
}: LoginConnectOrCreateWalletProps) {
  const { client } = useLogin();
  const auth = useAuth();
  const [isCreating, setIsCreating] = useState(false);
  const [embeddedWallet, setEmbeddedWallet] =
    useState<UserWalletCreateResult | null>(null);
  const [externalWalletState, setExternalWalletState] = useState<string | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  const embeddedRequestInFlightRef = useRef(false);

  const reportError = useCallback(
    (err: unknown, source: "embedded" | "evm" | "solana") => {
      const error = err instanceof Error ? err : new Error(String(err));
      setError(error.message);
      onError?.(error, source);
    },
    [onError],
  );

  const createEmbeddedWallet = useCallback(async () => {
    if (
      !auth.isAuthenticated ||
      embeddedWallet ||
      embeddedRequestInFlightRef.current
    )
      return;
    embeddedRequestInFlightRef.current = true;
    setIsCreating(true);
    setError(null);
    try {
      const result = await provisionEmbeddedWalletFallback(
        client,
        auth.isAuthenticated,
      );
      setEmbeddedWallet(result);
      onEmbeddedWallet?.(result);
    } catch (err) {
      reportError(err, "embedded");
    } finally {
      embeddedRequestInFlightRef.current = false;
      setIsCreating(false);
    }
  }, [
    auth.isAuthenticated,
    client,
    embeddedWallet,
    onEmbeddedWallet,
    reportError,
  ]);

  const requestAuthForEmbeddedWallet = useCallback(async () => {
    if (auth.isAuthenticated || isCreating || !onAuthRequired) return;
    setError(null);
    try {
      await onAuthRequired("embedded");
    } catch (err) {
      reportError(err, "embedded");
    }
  }, [auth.isAuthenticated, isCreating, onAuthRequired, reportError]);

  const handleExternalWallet = useCallback(
    (
      result: LoginAuthResult | LoginMfaRequiredResult,
      kind: "evm" | "solana",
    ) => {
      setError(null);
      setExternalWalletState(
        "mfaRequired" in result && result.mfaRequired
          ? `${kind === "evm" ? "ethereum" : "solana"} wallet connected, MFA required`
          : `${kind === "evm" ? "ethereum" : "solana"} wallet connected`,
      );
      onExternalWallet?.(result, kind);
    },
    [onExternalWallet],
  );

  const handleExternalError = useCallback(
    (err: Error, kind: "evm" | "solana") => reportError(err, kind),
    [reportError],
  );

  const embeddedAction = getEmbeddedWalletActionState({
    isAuthenticated: auth.isAuthenticated,
    isCreating,
    embeddedLabel,
    embeddedBusyLabel,
    embeddedSignedOutLabel,
    embeddedAuthRequiredLabel,
    embeddedReadyLabel: "wallet ready",
    hasAuthRequiredHandler: typeof onAuthRequired === "function",
    hasEmbeddedWallet: embeddedWallet !== null,
  });
  const embeddedDisplayState = getEmbeddedWalletDisplayState(embeddedWallet);

  return (
    <div
      className={cx("stwd-connect-or-create-wallet", classes?.root, className)}
      data-testid="stwd-connect-or-create-wallet"
    >
      {showExternalWallets ? (
        <WalletLogin
          chains={chains}
          classes={classes}
          evmLabel={evmLabel}
          solanaLabel={solanaLabel}
          evmSignLabel={evmSignLabel}
          solanaSignLabel={solanaSignLabel}
          onSuccess={handleExternalWallet}
          onError={handleExternalError}
        />
      ) : null}

      {showEmbeddedWallet ? (
        <div className={cx("stwd-wallet-column", classes?.column)}>
          <Button
            type="button"
            data-testid="stwd-connect-or-create-embedded"
            data-stwd-auth-state={
              embeddedAction.requiresAuth ? "signed-out" : "authenticated"
            }
            disabled={embeddedAction.disabled}
            onClick={() =>
              void (embeddedAction.requiresAuth
                ? requestAuthForEmbeddedWallet()
                : createEmbeddedWallet())
            }
          >
            {embeddedAction.label}
          </Button>
          {embeddedDisplayState ? (
            <div
              className={cx(
                "stwd-wallet-status",
                classes?.status,
                classes?.embeddedStatus,
              )}
              data-testid="stwd-connect-or-create-embedded-status"
              data-stwd-wallet-state={embeddedDisplayState.state}
            >
              <span className="stwd-wallet-state">
                {embeddedDisplayState.label}
              </span>
              <code className="stwd-wallet-addr">
                {embeddedDisplayState.walletAddress}
              </code>
            </div>
          ) : null}
        </div>
      ) : null}

      {externalWalletState ? (
        <div
          className={cx(
            "stwd-wallet-status",
            classes?.status,
            classes?.onboardingStatus,
          )}
          data-testid="stwd-connect-or-create-external-status"
          data-stwd-wallet-state="connected"
        >
          {externalWalletState}
        </div>
      ) : null}

      {error ? (
        <div
          className={cx("stwd-wallet-error", classes?.error)}
          data-testid="stwd-wallet-error"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}
