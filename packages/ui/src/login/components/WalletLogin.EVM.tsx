/** Connects an Ethereum wallet and signs the server-issued login challenge. */
import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useCallback, useContext, useState } from "react";
import { useAccount, useDisconnect, useSignMessage } from "wagmi";
import { Button } from "../../components/ui/button";
import { LoginAuthContext } from "../provider.js";
import { cx, type WalletLoginPanelProps } from "./WalletLogin.js";

export default function WalletLoginEVM({
  classes,
  onSuccess,
  onError,
  label,
  signLabel,
}: WalletLoginPanelProps) {
  const ctx = useContext(LoginAuthContext);
  const { address, isConnected, connector, chain } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const { disconnect } = useDisconnect();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signMessageFn = useCallback(
    async (msg: string) => {
      const sig = await signMessageAsync({ message: msg });
      return sig as string;
    },
    [signMessageAsync],
  );

  const handleSignIn = useCallback(async () => {
    setError(null);
    if (!ctx) {
      const err = new Error("WalletLogin needs <LoginProvider auth={...}>.");
      setError(err.message);
      onError?.(err, "evm");
      return;
    }
    if (!address) {
      const err = new Error("no EVM wallet connected");
      setError(err.message);
      onError?.(err, "evm");
      return;
    }
    setBusy(true);
    try {
      const result = await ctx.signInWithSIWE(address, signMessageFn);
      onSuccess?.(result, "evm");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err.message || "sign-in failed");
      onError?.(err, "evm");
    } finally {
      setBusy(false);
    }
  }, [ctx, address, signMessageFn, onSuccess, onError]);

  const walletName = connector?.name;
  const labelText = signLabel
    ? signLabel(walletName)
    : walletName
      ? `sign in with ${walletName}`
      : "sign in";

  return (
    <div className={cx("stwd-wallet-col", classes?.column)}>
      <h3 className={cx("stwd-wallet-heading", classes?.heading)}>{label}</h3>
      <div className="stwd-wallet-connector">
        <ConnectButton
          label="connect wallet"
          accountStatus="address"
          chainStatus="name"
          showBalance={false}
        />
      </div>
      {isConnected && address && (
        <>
          <div className={cx("stwd-wallet-status", classes?.status)}>
            <span className="stwd-wallet-addr">
              {address.slice(0, 6)}…{address.slice(-4)}
            </span>
            {chain?.name && (
              <span className="stwd-wallet-chain"> on {chain.name}</span>
            )}
          </div>
          <Button type="button" onClick={handleSignIn} disabled={busy}>
            {busy ? "signing..." : labelText}
          </Button>
          <Button
            type="button"
            variant="link"
            onClick={() => disconnect()}
            disabled={busy}
          >
            disconnect
          </Button>
        </>
      )}
      {!isConnected && (
        <p className={cx("stwd-wallet-hint", classes?.hint)}>
          connect a wallet
        </p>
      )}
      {error && (
        <div className={cx("stwd-wallet-error", classes?.error)} role="alert">
          {error}
        </div>
      )}
    </div>
  );
}
