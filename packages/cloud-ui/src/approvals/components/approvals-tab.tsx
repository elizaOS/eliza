/**
 * Approvals tab: lists the owner's pending approval requests and lets them
 * approve (via the wallet-signature gate) or deny inline.
 *
 * Approve flow (wallet-signature gate, zero backend change): for `wallet`
 * challenges we offer a one-click "Sign with wallet" that runs `personal_sign`
 * on the challenge message via the injected provider and submits the signature;
 * a paste-signature textarea is always available as the fallback (and the only
 * path for `ed25519` / non-wallet signers). The server-side
 * `IdentityVerificationGatekeeper` validates the signature exactly as it does
 * for the public approval page.
 */

import { CheckCircle2, Loader2, ShieldCheck, Wallet } from "lucide-react";
import { useCallback, useState } from "react";
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Textarea,
} from "@elizaos/ui/components/primitives";
import {
  type ApprovalRequest,
  formatApprovalTimestamp,
  useApprovalRequests,
  useApproveRequest,
  useDenyRequest,
} from "../lib/approvals";
import {
  isInjectedWalletAvailable,
  signApprovalChallenge,
  WalletSignError,
} from "../lib/wallet-sign";
import { StatusBadge } from "./status-badge";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function ApprovalCard({ request }: { request: ApprovalRequest }) {
  const approve = useApproveRequest();
  const deny = useDenyRequest();
  const [signature, setSignature] = useState("");
  const [signing, setSigning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const challenge = request.challengePayload;
  const signerKind = challenge.signerKind;
  const isTerminal =
    request.status === "approved" ||
    request.status === "denied" ||
    request.status === "expired" ||
    request.status === "canceled";
  const walletCapable = signerKind === "wallet" && isInjectedWalletAvailable();
  const busy = approve.isPending || deny.isPending || signing;

  const submitSignature = useCallback(
    async (value: string) => {
      const trimmed = value.trim();
      if (!trimmed) return;
      setError(null);
      try {
        await approve.mutateAsync({ id: request.id, signature: trimmed });
      } catch (caught) {
        setError(errorMessage(caught, "Failed to submit signature."));
      }
    },
    [approve, request.id],
  );

  const handleSignWithWallet = useCallback(async () => {
    setError(null);
    setSigning(true);
    try {
      const sig = await signApprovalChallenge(challenge.message);
      await submitSignature(sig);
    } catch (caught) {
      setError(
        caught instanceof WalletSignError
          ? caught.message
          : errorMessage(caught, "Wallet signing failed."),
      );
    } finally {
      setSigning(false);
    }
  }, [challenge.message, submitSignature]);

  const handleDeny = useCallback(async () => {
    const trimmed = signature.trim();
    if (!trimmed) return;
    setError(null);
    try {
      await deny.mutateAsync({ id: request.id, signature: trimmed });
    } catch (caught) {
      setError(errorMessage(caught, "Failed to deny approval."));
    }
  }, [deny, request.id, signature]);

  const expiresAt = formatApprovalTimestamp(request.expiresAt);

  return (
    <div className="rounded-md border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-accent" />
          <div>
            <p className="text-sm font-medium text-txt">
              {request.challengeKind} approval
            </p>
            {expiresAt ? (
              <p className="text-xs text-muted">Expires {expiresAt}</p>
            ) : null}
          </div>
        </div>
        <StatusBadge status={request.status} />
      </div>

      {challenge.message ? (
        <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-surface p-3 text-xs text-muted-strong">
          {challenge.message}
        </pre>
      ) : null}

      {error ? (
        <Alert className="mt-3" variant="destructive">
          <AlertTitle>Approval issue</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {!isTerminal ? (
        <div className="mt-4 space-y-3">
          {walletCapable ? (
            <Button
              type="button"
              onClick={handleSignWithWallet}
              disabled={busy}
              className="w-full"
            >
              {signing ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Wallet className="h-4 w-4" />
              )}
              Sign with wallet & approve
            </Button>
          ) : null}

          <div className="space-y-2">
            <label
              htmlFor={`sig-${request.id}`}
              className="block text-xs font-medium text-muted"
            >
              {walletCapable
                ? "Or paste a signature"
                : "Paste signature to approve or deny"}
            </label>
            <Textarea
              id={`sig-${request.id}`}
              value={signature}
              onChange={(event) => setSignature(event.target.value)}
              rows={3}
              disabled={busy}
              spellCheck={false}
              placeholder={
                signerKind === "wallet"
                  ? "0x..."
                  : signerKind === "ed25519"
                    ? "base64 ed25519 signature"
                    : "Paste signature"
              }
              className="font-mono text-xs"
            />
          </div>

          <div className="flex gap-2">
            <Button
              type="button"
              onClick={() => void submitSignature(signature)}
              disabled={busy || signature.trim().length === 0}
            >
              {approve.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="h-4 w-4" />
              )}
              Approve
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={handleDeny}
              disabled={busy || signature.trim().length === 0}
            >
              {deny.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : null}
              Deny
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function ApprovalsTab() {
  const query = useApprovalRequests();

  if (query.isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-muted" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <Alert variant="destructive">
        <AlertTitle>Could not load approvals</AlertTitle>
        <AlertDescription>
          {errorMessage(query.error, "Try again in a moment.")}
        </AlertDescription>
      </Alert>
    );
  }

  const pending = (query.data ?? []).filter(
    (request) => request.status === "pending" || request.status === "delivered",
  );

  if (pending.length === 0) {
    return (
      <p className="py-12 text-center text-sm text-muted">
        No pending approval requests.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {pending.map((request) => (
        <ApprovalCard key={request.id} request={request} />
      ))}
    </div>
  );
}
