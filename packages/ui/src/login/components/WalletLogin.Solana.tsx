/** Connects a Solana wallet and signs the server-issued login challenge. */
import { useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { useCallback, useContext, useState } from "react";
import { Button } from "../../components/ui/button";
import { LoginAuthContext } from "../provider.js";
import { cx, type WalletLoginPanelProps } from "./WalletLogin.js";

export default function WalletLoginSolana({
  classes,
  onSuccess,
  onError,
  label,
  signLabel,
}: WalletLoginPanelProps) {
  const ctx = useContext(LoginAuthContext);
  const wallet = useWallet();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSignIn = useCallback(async () => {
    setError(null);
    if (!ctx) {
      const err = new Error("WalletLogin needs <LoginProvider auth={...}>.");
      setError(err.message);
      onError?.(err, "solana");
      return;
    }
    if (!ctx.signInWithSolana) {
      const err = new Error(
        "solana sign-in unavailable. upgrade @elizaos/login to >= 0.8.0",
      );
      setError(err.message);
      onError?.(err, "solana");
      return;
    }
    if (!wallet.publicKey || !wallet.signMessage) {
      const err = new Error("wallet can't sign messages");
      setError(err.message);
      onError?.(err, "solana");
      return;
    }

    setBusy(true);
    try {
      const publicKey = wallet.publicKey.toBase58();
      const signMessageFn = async (msg: Uint8Array): Promise<Uint8Array> => {
        const out = await wallet.signMessage?.(msg);
        if (!out) throw new Error("wallet returned an empty signature");
        return out;
      };
      const result = await ctx.signInWithSolana(publicKey, signMessageFn);
      onSuccess?.(result, "solana");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      setError(err.message || "sign-in failed");
      onError?.(err, "solana");
    } finally {
      setBusy(false);
    }
  }, [ctx, wallet, onSuccess, onError]);

  const walletName = wallet.wallet?.adapter?.name;
  const labelText = signLabel
    ? signLabel(walletName)
    : walletName
      ? `sign in with ${walletName}`
      : "sign in";
  const addr = wallet.publicKey?.toBase58();

  return (
    <div className={cx("stwd-wallet-col", classes?.column)}>
      <h3 className={cx("stwd-wallet-heading", classes?.heading)}>{label}</h3>
      <div className="stwd-wallet-connector">
        <WalletMultiButton />
      </div>
      {wallet.connected && addr && (
        <>
          <div className={cx("stwd-wallet-status", classes?.status)}>
            <span className="stwd-wallet-addr">
              {addr.slice(0, 4)}…{addr.slice(-4)}
            </span>
          </div>
          <Button
            type="button"
            onClick={handleSignIn}
            disabled={busy || !ctx?.signInWithSolana}
          >
            {busy ? "signing..." : labelText}
          </Button>
        </>
      )}
      {!wallet.connected && (
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
