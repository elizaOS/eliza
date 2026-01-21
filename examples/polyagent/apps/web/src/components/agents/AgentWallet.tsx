"use client";

import { cn } from "@polyagent/shared";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  History,
  TrendingUp,
  Wallet,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { useAuth } from "@/hooks/useAuth";

/**
 * Transaction structure for agent wallet.
 */
interface Transaction {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
}

/**
 * Agent wallet component for managing agent balance.
 *
 * Provides interface for depositing/withdrawing from agent's unified balance.
 * This balance is used for both AI operations (chat, tick, post) and trading.
 *
 * @param props - AgentWallet component props
 * @returns Agent wallet element
 */
interface AgentWalletProps {
  agent: {
    id: string;
    name: string;
    virtualBalance?: number;
    lifetimePnL?: string;
  };
  onUpdate: () => void;
}

export function AgentWallet({ agent, onUpdate }: AgentWalletProps) {
  const { getAccessToken } = useAuth();

  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [amount, setAmount] = useState("");
  const [action, setAction] = useState<"deposit" | "withdraw">("deposit");
  const [processing, setProcessing] = useState(false);

  // Balance state
  const [balanceInfo, setBalanceInfo] = useState({
    agentBalance: agent.virtualBalance ?? 0,
    userBalance: 0,
    lifetimePnL: parseFloat(agent.lifetimePnL ?? "0"),
  });

  const fetchBalanceAndTransactions = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;

    const res = await fetch(`/api/agents/${agent.id}/trading-balance`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        setBalanceInfo({
          agentBalance: data.agentBalance.tradingBalance,
          userBalance: data.userBalance,
          lifetimePnL: data.agentBalance.lifetimePnL,
        });
        setTransactions(data.transactions || []);
      }
    }
  }, [agent.id, getAccessToken]);

  useEffect(() => {
    setLoading(true);
    fetchBalanceAndTransactions().finally(() => setLoading(false));
  }, [fetchBalanceAndTransactions]);

  const handleTransaction = async () => {
    const amountNum = parseFloat(amount);

    if (!amountNum || amountNum <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (action === "deposit" && amountNum > balanceInfo.userBalance) {
      toast.error(
        `Insufficient balance. You have ${balanceInfo.userBalance.toFixed(2)} pts`,
      );
      return;
    }
    if (action === "withdraw" && amountNum > balanceInfo.agentBalance) {
      toast.error(
        `Insufficient agent balance. Agent has ${balanceInfo.agentBalance.toFixed(2)} pts`,
      );
      return;
    }

    setProcessing(true);
    const token = await getAccessToken();
    if (!token) {
      setProcessing(false);
      toast.error("Authentication required");
      return;
    }

    try {
      const res = await fetch(`/api/agents/${agent.id}/trading-balance`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ action, amount: amountNum }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || "Transaction failed");
      }

      const data = await res.json();
      toast.success(data.message);
      setAmount("");

      await fetchBalanceAndTransactions();
      onUpdate();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Transaction failed",
      );
    } finally {
      setProcessing(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Balance Card */}
      <div className="rounded-lg border border-[#0066FF]/30 bg-[#0066FF]/5 p-6">
        <div className="mb-2 flex items-center gap-2 text-[#0066FF] text-sm">
          <Wallet className="h-4 w-4" />
          Agent Balance
        </div>
        <div className="mb-4 font-bold text-3xl">
          {balanceInfo.agentBalance.toFixed(2)} pts
        </div>
        <div className="space-y-1 text-muted-foreground text-sm">
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1">
              <TrendingUp className="h-3 w-3" />
              Lifetime P&L:
            </span>
            <span
              className={cn(
                "font-medium",
                balanceInfo.lifetimePnL >= 0
                  ? "text-green-600"
                  : "text-red-600",
              )}
            >
              {balanceInfo.lifetimePnL >= 0 ? "+" : ""}
              {balanceInfo.lifetimePnL.toFixed(2)} pts
            </span>
          </div>
        </div>
        <p className="mt-3 text-muted-foreground text-xs">
          Used for trading and AI operations (chat, autonomous actions)
        </p>
      </div>

      {/* Transaction Form */}
      <div className="rounded-lg border border-border bg-card/50 p-4 backdrop-blur sm:p-6">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-semibold text-lg">Transfer</h3>
          <div className="text-right text-sm">
            <span className="text-muted-foreground">Your Balance: </span>
            <span className="font-medium">
              {balanceInfo.userBalance.toFixed(2)} pts
            </span>
          </div>
        </div>

        {/* Action Toggle */}
        <div className="mb-4 grid grid-cols-2 gap-2">
          <button
            onClick={() => setAction("deposit")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg px-3 py-3 font-medium transition-all sm:px-4",
              action === "deposit"
                ? "bg-[#0066FF] text-primary-foreground"
                : "bg-muted text-foreground hover:bg-muted/80",
            )}
          >
            <ArrowDownToLine className="h-4 w-4 shrink-0" />
            <span>Deposit</span>
          </button>
          <button
            onClick={() => setAction("withdraw")}
            className={cn(
              "flex items-center justify-center gap-2 rounded-lg px-3 py-3 font-medium transition-all sm:px-4",
              action === "withdraw"
                ? "bg-[#0066FF] text-primary-foreground"
                : "bg-muted text-foreground hover:bg-muted/80",
            )}
          >
            <ArrowUpFromLine className="h-4 w-4 shrink-0" />
            <span>Withdraw</span>
          </button>
        </div>

        {/* Amount input and submit */}
        <div className="flex flex-col gap-3 sm:flex-row sm:gap-2">
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Enter amount (pts)..."
            min={0.01}
            step={0.01}
            max={
              action === "deposit"
                ? balanceInfo.userBalance
                : balanceInfo.agentBalance
            }
            className="h-12 w-full text-base sm:h-10 sm:flex-1 sm:text-sm"
          />
          <button
            onClick={handleTransaction}
            disabled={processing || !amount}
            className="h-12 w-full rounded-lg bg-[#0066FF] px-6 font-medium text-white transition-all hover:bg-[#2952d9] disabled:cursor-not-allowed disabled:opacity-50 sm:h-10 sm:w-auto"
          >
            {processing
              ? "Processing..."
              : action === "deposit"
                ? "Deposit"
                : "Withdraw"}
          </button>
        </div>

        <p className="mt-3 text-muted-foreground text-xs">
          {action === "deposit"
            ? `Transfer pts from your balance to ${agent.name}`
            : `Transfer pts from ${agent.name} to your balance`}
        </p>
      </div>

      {/* Transaction History */}
      <div className="rounded-lg border border-border bg-card/50 p-6 backdrop-blur">
        <div className="mb-4 flex items-center gap-2">
          <History className="h-5 w-5" />
          <h3 className="font-semibold text-lg">Transaction History</h3>
        </div>

        {loading ? (
          <div className="py-8 text-center text-muted-foreground">
            Loading...
          </div>
        ) : transactions.length === 0 ? (
          <div className="py-8 text-center text-muted-foreground">
            No transactions yet
          </div>
        ) : (
          <div className="space-y-2">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between rounded-lg bg-muted/30 p-3 transition-all hover:bg-muted"
              >
                <div className="flex-1">
                  <div className="font-medium capitalize">
                    {tx.type.replace(/_/g, " ")}
                  </div>
                  <div className="text-muted-foreground text-sm">
                    {tx.description}
                  </div>
                  <div className="text-muted-foreground text-xs">
                    {new Date(tx.createdAt).toLocaleString()}
                  </div>
                </div>
                <div className="text-right">
                  <div
                    className={cn(
                      "font-semibold",
                      tx.amount > 0 ? "text-green-600" : "text-red-600",
                    )}
                  >
                    {tx.amount > 0 ? "+" : ""}
                    {Math.abs(tx.amount).toFixed(2)} pts
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Balance: {tx.balanceAfter.toFixed(2)} pts
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
