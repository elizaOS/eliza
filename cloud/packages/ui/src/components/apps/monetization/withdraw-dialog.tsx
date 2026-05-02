/**
 * Withdrawal dialog component with confirmation and celebration effects.
 * Shows processing state and confetti on successful withdrawal.
 */

"use client";

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
} from "@elizaos/cloud-ui";
import confetti from "canvas-confetti";
import { AlertCircle, ArrowRight, CheckCircle2, Loader2, Wallet } from "lucide-react";
import { useCallback, useState } from "react";

interface WithdrawDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  appId: string;
  withdrawableBalance: number;
  payoutThreshold: number;
  onSuccess?: (newBalance: number) => void;
}

type WithdrawState = "confirm" | "processing" | "success" | "error";

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
  const [newBalance, setNewBalance] = useState(0);

  const parsedAmount = parseFloat(amount) || 0;
  const isValidAmount = parsedAmount >= payoutThreshold && parsedAmount <= withdrawableBalance;

  const triggerConfetti = useCallback(() => {
    // Fire confetti from both sides
    const count = 200;
    const defaults = {
      origin: { y: 0.7 },
      zIndex: 9999,
    };

    function fire(particleRatio: number, opts: confetti.Options) {
      confetti({
        ...defaults,
        ...opts,
        particleCount: Math.floor(count * particleRatio),
      });
    }

    // Left side burst
    fire(0.25, {
      spread: 26,
      startVelocity: 55,
      origin: { x: 0.2, y: 0.7 },
      colors: ["#FF5800", "#FF8C00", "#FFD700"],
    });

    // Right side burst
    fire(0.25, {
      spread: 26,
      startVelocity: 55,
      origin: { x: 0.8, y: 0.7 },
      colors: ["#FF5800", "#FF8C00", "#FFD700"],
    });

    // Center burst
    fire(0.35, {
      spread: 100,
      decay: 0.91,
      scalar: 0.8,
      origin: { x: 0.5, y: 0.6 },
      colors: ["#FF5800", "#FF8C00", "#FFD700", "#FFFFFF"],
    });

    // Smaller follow-up burst
    setTimeout(() => {
      fire(0.1, {
        spread: 120,
        startVelocity: 25,
        decay: 0.92,
        scalar: 1.2,
        origin: { x: 0.5, y: 0.5 },
        colors: ["#FF5800", "#22C55E"],
      });
    }, 200);
  }, []);

  const handleWithdraw = async () => {
    setState("processing");
    setError(null);

    try {
      const response = await fetch(`/api/v1/apps/${appId}/earnings/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ amount: parsedAmount }),
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        setState("error");
        setError(data.error || "Withdrawal failed. Please try again.");
        return;
      }

      setNewBalance(data.newBalance ?? 0);
      setState("success");
      triggerConfetti();
      onSuccess?.(data.newBalance ?? 0);
    } catch (err) {
      setState("error");
      setError(
        err instanceof Error
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
      <DialogContent className="sm:max-w-md bg-neutral-900 border-white/10">
        {state === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-white">
                <Wallet className="h-5 w-5 text-[#FF5800]" />
                Withdraw Earnings
              </DialogTitle>
              <DialogDescription className="text-neutral-400">
                Mark earnings as withdrawn. These funds are already in your redeemable balance and
                can be redeemed as elizaOS tokens.
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 py-4">
              {/* Balance display */}
              <div className="flex items-center justify-between p-3 bg-black/30 rounded-lg border border-white/10">
                <span className="text-sm text-neutral-400">Available Balance</span>
                <span className="text-lg font-mono font-semibold text-emerald-400">
                  ${withdrawableBalance.toFixed(2)}
                </span>
              </div>

              {/* Amount input */}
              <div className="space-y-2">
                <label className="text-xs text-neutral-400">Withdrawal Amount</label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500">
                    $
                  </span>
                  <Input
                    type="number"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    className="pl-7 bg-black/40 border-white/10 text-white font-mono focus:border-[#FF5800]/50"
                    min={payoutThreshold}
                    max={withdrawableBalance}
                    step="0.01"
                  />
                </div>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-neutral-500">Minimum: ${payoutThreshold.toFixed(2)}</span>
                  <button
                    onClick={() => setAmount(withdrawableBalance.toFixed(2))}
                    className="text-[#FF5800] hover:text-[#FF5800]/80 transition-colors"
                  >
                    Withdraw All
                  </button>
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
                className="text-neutral-400 hover:text-white"
              >
                Cancel
              </Button>
              <Button
                onClick={handleWithdraw}
                disabled={!isValidAmount}
                className="bg-[#FF5800] hover:bg-[#FF5800]/80 text-white disabled:opacity-50"
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
              <Loader2 className="h-8 w-8 text-[#FF5800] animate-spin" />
            </div>
            <h3 className="text-lg font-medium text-white mb-2">Processing Withdrawal</h3>
            <p className="text-sm text-neutral-400">This may take a few moments...</p>
          </div>
        )}

        {state === "success" && (
          <div className="py-8 text-center">
            <div className="mx-auto w-16 h-16 mb-4 flex items-center justify-center bg-emerald-500/10 rounded-full border border-emerald-500/30">
              <CheckCircle2 className="h-8 w-8 text-emerald-400" />
            </div>
            <h3 className="text-xl font-semibold text-white mb-2">Withdrawal Complete!</h3>
            <p className="text-neutral-400 mb-2">${parsedAmount.toFixed(2)} marked as withdrawn</p>
            <p className="text-xs text-neutral-500 mb-4">
              Visit your Earnings page to redeem as elizaOS tokens
            </p>
            <div className="inline-block p-3 bg-black/30 rounded-lg border border-white/10">
              <span className="text-xs text-neutral-500">Remaining App Balance</span>
              <p className="text-lg font-mono font-semibold text-white">${newBalance.toFixed(2)}</p>
            </div>
            <DialogFooter className="mt-6">
              <Button
                onClick={handleClose}
                className="w-full bg-[#FF5800] hover:bg-[#FF5800]/80 text-white"
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
            <h3 className="text-lg font-medium text-white mb-2">Withdrawal Failed</h3>
            <p className="text-sm text-red-400 mb-4">{error}</p>
            <DialogFooter className="flex gap-2 justify-center">
              <Button
                variant="ghost"
                onClick={handleClose}
                className="text-neutral-400 hover:text-white"
              >
                Cancel
              </Button>
              <Button
                onClick={() => setState("confirm")}
                className="bg-white/10 hover:bg-white/20 text-white"
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
