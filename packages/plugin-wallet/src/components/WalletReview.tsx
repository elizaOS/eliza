// spec/wallet/index.md, "Story: Preview an exact wallet operation before executing it"; spec/wallet/index.md, "A review binds the complete immutable wallet operation"
import { Button, Card, CardFooter } from "@repo/ui";
import type { ManagedRuntime } from "effect";
import { useState, useTransition } from "react";
import { useMachine } from "../../gen/wallet.react.ts";
import type { Machine } from "../../gen/wallet.effect.vibe";
import type { WalletOwnerDecision, WalletOwnerReviewDetails, WalletOwnerReviewResult } from "../index.vibe";

export interface WalletReviewProps {
  readonly runtime: ManagedRuntime.ManagedRuntime<Machine, never>;
  readonly details: WalletOwnerReviewDetails;
  readonly decide: (decision: WalletOwnerDecision) => Promise<WalletOwnerReviewResult>;
}

export function WalletReview({ runtime, details, decide }: WalletReviewProps) {
  const { state, cause, can } = useMachine(runtime);
  const [submitting, start] = useTransition();
  const [error, setError] = useState("");
  const matching = state?.intent.intentId === details.intent.intentId && state?.intent.commitment === details.intent.commitment;
  const ready = matching && !submitting;
  const outcome = matching && (state?.phase === "WalletInFlight" || state?.phase === "WalletUncertain") ? "Awaiting transaction outcome"
    : matching && state?.phase === "WalletSigning" ? "Preparing transaction"
    : matching && state?.phase === "WalletDeclined" ? "Declined"
    : matching && state?.phase === "WalletFinal" ? "Final"
    : "";
  const choose = (decision: WalletOwnerDecision["decision"]) => {
    if (!ready || state?.phase !== "AwaitingWalletApproval") return;
    const { intentId, commitment } = details.intent;
    if (decision === "approve" && !can({ type: "approveWallet", intentId, commitment, wallTime: Date.now(), ownerConfirmed: true })) {
      setError("This wallet review expired.");
      return;
    }
    setError("");
    start(async () => {
      try {
        await decide({ decision, intentId, commitment });
      } catch {
        setError("The transfer could not be submitted. Refresh the review.");
      }
    });
  };
  if (cause !== undefined) return <p role="alert">Wallet review is unavailable.</p>;
  if (state === undefined) return <p role="status">Loading wallet review…</p>;
  if (!matching) return <p role="alert">This wallet review expired.</p>;
  return (
    <Card aria-busy={submitting}>
      <h2 className="text-lg font-semibold">Review wallet transfer</h2>
      <p className="text-2xl font-semibold tabular-nums">{details.atomicUnits} <span className="text-sm text-muted-foreground">atomic units</span></p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Network</dt>
        <dd className="break-all">{details.intent.family === "EvmWallet" ? "EVM" : "Solana"} · {details.intent.chainId}</dd>
        <dt className="text-muted-foreground">From</dt>
        <dd className="break-all font-mono">{details.intent.account}</dd>
        <dt className="text-muted-foreground">To</dt>
        <dd className="break-all font-mono">{details.recipient}</dd>
        <dt className="text-muted-foreground">Maximum fee</dt>
        <dd className="tabular-nums">{details.maximumFee} atomic units</dd>
        <dt className="text-muted-foreground">Expires</dt>
        <dd><time dateTime={new Date(details.expiresAt).toISOString()}>{new Date(details.expiresAt).toLocaleTimeString()}</time></dd>
        {state.operationRef === "" ? null : <>
          <dt className="text-muted-foreground">Transaction</dt>
          <dd className="break-all font-mono">{state.operationRef}</dd>
        </>}
      </dl>
      {error === "" ? null : <p role="alert">{error}</p>}
      {outcome === "" ? null : <p role="status">{outcome}</p>}
      {state.phase !== "AwaitingWalletApproval" ? null : (
        <CardFooter>
          <Button variant="outline" disabled={!ready || !can({ type: "declineWallet" })} onClick={() => choose("decline")}>Decline</Button>
          <Button disabled={!ready} onClick={() => choose("approve")}>{submitting ? "Submitting…" : "Approve and send"}</Button>
        </CardFooter>
      )}
    </Card>
  );
}
