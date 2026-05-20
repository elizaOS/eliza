"use client";

import { cn, formatCompactCurrency } from "@feed/shared";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  History,
  Loader2,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { useAuth } from "@/hooks/useAuth";
import { apiUrl } from "@/utils/api-url";

interface Transaction {
  id: string;
  type: string;
  amount: number;
  balanceBefore: number;
  balanceAfter: number;
  description: string;
  createdAt: string;
}

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

  const [balanceInfo, setBalanceInfo] = useState({
    agentBalance: agent.virtualBalance ?? 0,
    userBalance: 0,
    lifetimePnL: parseFloat(agent.lifetimePnL ?? "0"),
  });

  const fetchBalanceAndTransactions = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;

    const res = await fetch(apiUrl(`/api/agents/${agent.id}/trading-balance`), {
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
      const res = await fetch(
        apiUrl(`/api/agents/${agent.id}/trading-balance`),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ action, amount: amountNum }),
        },
      );

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

  const isProfitable = balanceInfo.lifetimePnL >= 0;

  return (
    <div className="flex flex-col gap-3 p-4">
      {/* Balance Summary */}
      <div className="divide-y divide-border/60 rounded-lg border border-border/60 bg-card/50">
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-muted-foreground text-xs">Agent Balance</span>
          <span className="font-semibold text-foreground text-sm">
            {formatCompactCurrency(balanceInfo.agentBalance)}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-muted-foreground text-xs">Lifetime P&L</span>
          <span
            className={cn(
              "flex items-center gap-1 font-semibold text-sm",
              isProfitable ? "text-green-600" : "text-red-600",
            )}
          >
            {isProfitable ? (
              <TrendingUp className="h-3 w-3" />
            ) : (
              <TrendingDown className="h-3 w-3" />
            )}
            {isProfitable ? "+" : ""}
            {formatCompactCurrency(balanceInfo.lifetimePnL)}
          </span>
        </div>
        <div className="flex items-center justify-between px-3 py-2.5">
          <span className="text-muted-foreground text-xs">Your Balance</span>
          <span className="font-semibold text-foreground text-sm">
            {formatCompactCurrency(balanceInfo.userBalance)}
          </span>
        </div>
      </div>

      {/* Transfer */}
      <div className="rounded-lg border border-border p-3">
        <div className="mb-2.5 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={() => setAction("deposit")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-xs transition-colors",
              action === "deposit"
                ? "bg-[#0066FF] text-white"
                : "bg-muted text-foreground hover:bg-muted/80",
            )}
          >
            <ArrowDownToLine className="h-3.5 w-3.5" />
            Deposit
          </button>
          <button
            type="button"
            onClick={() => setAction("withdraw")}
            className={cn(
              "flex items-center justify-center gap-1.5 rounded-md px-2 py-1.5 font-medium text-xs transition-colors",
              action === "withdraw"
                ? "bg-[#0066FF] text-white"
                : "bg-muted text-foreground hover:bg-muted/80",
            )}
          >
            <ArrowUpFromLine className="h-3.5 w-3.5" />
            Withdraw
          </button>
        </div>

        <div className="flex gap-2">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="Amount..."
            min={0.01}
            step={0.01}
            max={
              action === "deposit"
                ? balanceInfo.userBalance
                : balanceInfo.agentBalance
            }
            className="min-w-0 flex-1 rounded-md border border-border bg-muted px-2.5 py-1.5 text-xs focus:outline-none focus:ring-1 focus:ring-[#0066FF]"
          />
          <button
            type="button"
            onClick={handleTransaction}
            disabled={processing || !amount}
            className="shrink-0 rounded-md bg-[#0066FF] px-3 py-1.5 font-medium text-white text-xs transition-colors hover:bg-[#2952d9] disabled:opacity-50"
          >
            {processing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : action === "deposit" ? (
              "Deposit"
            ) : (
              "Withdraw"
            )}
          </button>
        </div>

        <p className="mt-2 text-[10px] text-muted-foreground">
          {action === "deposit"
            ? `Transfer from your balance to ${agent.name}`
            : `Transfer from ${agent.name} to your balance`}
        </p>
      </div>

      {/* Transaction History */}
      <div>
        <div className="mb-2 flex items-center gap-1.5 px-1">
          <History className="h-3.5 w-3.5 text-muted-foreground" />
          <span className="font-medium text-xs">History</span>
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
          </div>
        ) : transactions.length === 0 ? (
          <div className="py-6 text-center text-muted-foreground text-xs">
            No transactions yet
          </div>
        ) : (
          <div className="space-y-1">
            {transactions.map((tx) => (
              <div
                key={tx.id}
                className="flex items-center justify-between rounded-md bg-muted/30 px-2.5 py-2 transition-colors hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium text-xs capitalize">
                    {tx.type.replace(/_/g, " ")}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">
                    {tx.description}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {new Date(tx.createdAt).toLocaleString(undefined, {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </div>
                </div>
                <div className="shrink-0 pl-2 text-right">
                  <div
                    className={cn(
                      "font-semibold text-xs",
                      tx.amount > 0 ? "text-green-600" : "text-red-600",
                    )}
                  >
                    {tx.amount > 0 ? "+" : ""}
                    {formatCompactCurrency(Math.abs(tx.amount))}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    Bal: {formatCompactCurrency(tx.balanceAfter)}
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
