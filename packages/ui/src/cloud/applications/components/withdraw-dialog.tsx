/**
 * Withdrawal dialog with confirmation + result states.
 *
 * POST `/api/v1/apps/:id/earnings/withdraw` is routed through the typed `api`
 * client.
 */

import {
  AlertCircle,
  ArrowRight,
  CheckCircle2,
  Loader2,
  Wallet,
} from "lucide-react";
import { useState } from "react";
import { Button } from "../../../components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog";
import { Input } from "../../../components/ui/input";
import { ApiError, api } from "../../lib/api-client";

interface WithdrawDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: string;
  withdrawableBalance: number;
  payoutThreshold: number;
  onSuccess?: (newBalance: number) => void;
}

type WithdrawState = "confirm" | "processing" | "success" | "error";

interface WithdrawResponse {
  success?: boolean;
  newBalance?: number;
  error?: string;
}

export function WithdrawDialog({
  open,
  onOpenChange,
  appId,
  withdrawableBalance,
  payoutThreshold,
  onSuccess,
}: WithdrawDialogProps) {
  const [state, setState] = useState<WithdrawState>("confirm");
  const [amount, setAmount] = useState(withdrawableBalance.toFixed(2));
  const [error, setError] = useState<string | null>(null);
  const [newBalance, setNewBalance] = useState<number | null>(null);

  const parsedAmount = parseFloat(amount) || 0;
  const isValidAmount =
    parsedAmount >= payoutThreshold && parsedAmount <= withdrawableBalance;

  const handleWithdraw = async () => {
    setState("processing");
    setError(null);

    try {
      const data = await api<WithdrawResponse>(
        `/api/v1/apps/${appId}/earnings/withdraw`,
        { method: "POST", json: { amount: parsedAmount } },
      );

      if (!data.success) {
        setState("error");
        setError(data.error || "Withdrawal failed. Please try again.");
        return;
      }

      const returnedBalance =
        typeof data.newBalance === "number" ? data.newBalance : null;
      setNewBalance(returnedBalance);
      setState("success");
      if (returnedBalance !== null) {
        onSuccess?.(returnedBalance);
      }
    } catch (err) {
      setState("error");
      setError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : "Network error. Please check your connection and try again.",
      );
    }
  };

  const handleClose = () => {
    onOpenChange(false);
    // Reset state after dialog closes
    setTimeout(() => {
      setState("confirm");
      setAmount(withdrawableBalance.toFixed(2));
      setError(null);
    }, 300);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md bg-neutral-900 border-border">
        {state === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-txt">
                <Wallet className="h-5 w-5 text-[var(--brand-orange)]" />
                Withdraw Earnings
              </DialogTitle>
              <DialogDescription className="text-neutral-400">
                Mark earnings as withdrawn. These funds are already in your
                redeemable balance and can be redeemed as elizaOS tokens.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Balance display */}
              <div className="flex items-center justify-between p-3 bg-surface rounded-sm border border-border">
                <span className="text-sm text-neutral-400">
                  Available Balance
                </span>
                <span className="text-lg font-mono font-semibold text-green-400">
                  ${withdrawableBalance.toFixed(2)}
                </span>
              </div>

              {/* Amount input */}
              <div className="space-y-2">
                <label
                  htmlFor="withdraw-amount"
                  className="text-xs text-neutral-400"
                >
                  Withdrawal Amount
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">
                    $
                  </span>
                  <Input
                    id="withdraw-amount"
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="pl-7 bg-surface border-border text-txt font-mono "
                    min={payoutThreshold}
                    max={withdrawableBalance}
                    step="0.01"
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-500">
                    Minimum: ${payoutThreshold.toFixed(2)}
                  </span>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() => setAmount(withdrawableBalance.toFixed(2))}
                    className="text-muted hover:text-txt transition-colors"
                  >
                    Withdraw All
                  </Button>
                </div>
              </div>

              {/* Validation message */}
              {!isValidAmount && parsedAmount > 0 && (
                <div className="flex items-center gap-2 text-xs text-red-400">
                  <AlertCircle className="h-3 w-3" />
                  {parsedAmount < payoutThreshold
                    ? `Minimum withdrawal is $${payoutThreshold.toFixed(2)}`
                    : `Maximum withdrawal is $${withdrawableBalance.toFixed(2)}`}
                </div>
              )}
            </div>

            <DialogFooter className="flex gap-2">
              <Button
                variant="ghost"
                onClick={handleClose}
                className="text-neutral-400 hover:text-txt"
              >
                Cancel
              </Button>
              <Button
                onClick={handleWithdraw}
                disabled={!isValidAmount}
                className="bg-[var(--brand-orange)] hover:bg-[#e54f00] text-txt disabled:opacity-50"
              >
                <ArrowRight className="h-4 w-4 mr-2" />
                Withdraw ${parsedAmount.toFixed(2)}
              </Button>
            </DialogFooter>
          </>
        )}

        {state === "processing" && (
          <div className="py-12 text-center">
            <div className="mx-auto w-16 h-16 mb-4 flex items-center justify-center">
              <Loader2 className="h-8 w-8 text-[var(--brand-orange)] animate-spin" />
            </div>
            <h3 className="text-lg font-medium text-txt-strong mb-2">
              Processing Withdrawal
            </h3>
            <p className="text-sm text-neutral-400">
              This may take a few moments...
            </p>
          </div>
        )}

        {state === "success" && (
          <div className="py-8 text-center">
            <div className="mx-auto w-16 h-16 mb-4 flex items-center justify-center bg-green-500/10 rounded-full border border-green-500/30">
              <CheckCircle2 className="h-8 w-8 text-green-400" />
            </div>
            <h3 className="text-xl font-semibold text-txt-strong mb-2">
              Withdrawal Complete!
            </h3>
            <p className="text-neutral-400 mb-2">
              ${parsedAmount.toFixed(2)} marked as withdrawn
            </p>
            <p className="text-xs text-neutral-500 mb-4">
              Visit your Earnings page to redeem as elizaOS tokens
            </p>
            <div className="inline-block p-3 bg-surface rounded-sm border border-border">
              <span className="text-xs text-neutral-500">
                Remaining App Balance
              </span>
              {newBalance !== null ? (
                <p className="text-lg font-mono font-semibold text-txt-strong">
                  ${newBalance.toFixed(2)}
                </p>
              ) : (
                <p className="text-xs font-mono text-neutral-400 mt-1">
                  Withdrawal succeeded; refresh to see new balance.
                </p>
              )}
            </div>
            <DialogFooter className="mt-6">
              <Button
                onClick={handleClose}
                className="w-full bg-[var(--brand-orange)] hover:bg-[#e54f00] text-txt"
              >
                Done
              </Button>
            </DialogFooter>
          </div>
        )}

        {state === "error" && (
          <div className="py-8 text-center">
            <div className="mx-auto w-16 h-16 mb-4 flex items-center justify-center bg-red-500/10 rounded-full border border-red-500/30">
              <AlertCircle className="h-8 w-8 text-red-400" />
            </div>
            <h3 className="text-lg font-medium text-txt-strong mb-2">
              Withdrawal Failed
            </h3>
            <p className="text-sm text-red-400 mb-4">{error}</p>
            <DialogFooter className="flex gap-2 justify-center">
              <Button
                variant="ghost"
                onClick={handleClose}
                className="text-neutral-400 hover:text-txt"
              >
                Cancel
              </Button>
              <Button
                onClick={() => setState("confirm")}
                className="bg-surface hover:bg-surface text-txt"
              >
                Try Again
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
