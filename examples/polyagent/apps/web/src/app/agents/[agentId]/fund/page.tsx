"use client";

import { cn } from "@polyagent/shared";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle,
  Copy,
  ExternalLink,
  Loader2,
  Wallet,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { PageContainer } from "@/components/shared/PageContainer";
import { Skeleton } from "@/components/shared/Skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useSmartWallet } from "@/hooks/useSmartWallet";

interface Agent {
  id: string;
  displayName: string;
  username: string;
  walletAddress: string | null;
  balance: number;
}

export default function FundAgentPage() {
  const params = useParams();
  const router = useRouter();
  const { authenticated, ready, getAccessToken } = useAuth();
  const { sendTransaction, address: userWalletAddress } = useSmartWallet();
  const agentId = params.agentId as string;

  const [agent, setAgent] = useState<Agent | null>(null);
  const [loading, setLoading] = useState(true);
  const [amount, setAmount] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [userBalance, setUserBalance] = useState<number | null>(null);

  const fetchAgent = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) {
      toast.error("Authentication required");
      router.push("/agents");
      return;
    }

    try {
      const res = await fetch(`/api/agents/${agentId}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.ok) {
        const data = await res.json();
        setAgent(data.agent);
      } else {
        toast.error("Agent not found");
        router.push("/agents");
      }
    } catch {
      toast.error("Failed to load agent");
    } finally {
      setLoading(false);
    }
  }, [agentId, getAccessToken, router]);

  const fetchUserBalance = useCallback(async () => {
    const token = await getAccessToken();
    if (!token) return;

    try {
      const res = await fetch("/api/users/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        setUserBalance(data.user?.balance ?? 0);
      }
    } catch {
      // Silent fail
    }
  }, [getAccessToken]);

  useEffect(() => {
    if (ready && authenticated && agentId) {
      fetchAgent();
      fetchUserBalance();
    }
  }, [ready, authenticated, agentId, fetchAgent, fetchUserBalance]);

  const copyAddress = () => {
    if (agent?.walletAddress) {
      navigator.clipboard.writeText(agent.walletAddress);
      setCopied(true);
      toast.success("Address copied to clipboard");
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleSendFunds = async () => {
    if (!agent?.walletAddress) {
      toast.error("Agent wallet not available");
      return;
    }

    const amountNum = parseFloat(amount);
    if (Number.isNaN(amountNum) || amountNum <= 0) {
      toast.error("Please enter a valid amount");
      return;
    }

    if (userBalance !== null && amountNum > userBalance) {
      toast.error("Insufficient balance");
      return;
    }

    setIsSending(true);

    try {
      const token = await getAccessToken();
      if (!token) {
        toast.error("Authentication required");
        return;
      }

      // Call API to transfer funds to agent
      const res = await fetch(`/api/agents/${agentId}/fund`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          amount: amountNum,
        }),
      });

      if (res.ok) {
        toast.success(`Successfully sent $${amountNum} USDC to agent`);
        setAmount("");
        // Refresh agent data
        await fetchAgent();
        await fetchUserBalance();
      } else {
        const error = await res.json().catch(() => ({}));
        toast.error(error.message || "Failed to send funds");
      }
    } catch (error) {
      console.error("Failed to send funds:", error);
      toast.error("Failed to send funds");
    } finally {
      setIsSending(false);
    }
  };

  if (!ready || loading) {
    return (
      <PageContainer>
        <div className="mx-auto max-w-xl space-y-6">
          <Skeleton className="h-10 w-32" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-64 w-full" />
        </div>
      </PageContainer>
    );
  }

  if (!authenticated || !agent) {
    return (
      <PageContainer>
        <div className="flex flex-col items-center justify-center py-16">
          <Wallet className="mb-4 h-16 w-16 text-muted-foreground" />
          <h3 className="mb-2 font-bold text-2xl">Agent Not Found</h3>
          <p className="mb-6 text-muted-foreground">
            This agent doesn't exist or you don't have access
          </p>
          <Link href="/agents">
            <Button>Back to Agents</Button>
          </Link>
        </div>
      </PageContainer>
    );
  }

  const hasWallet = !!agent.walletAddress;

  return (
    <PageContainer>
      <div className="mx-auto max-w-xl space-y-6">
        {/* Header */}
        <div>
          <Button
            onClick={() => router.push(`/agents/${agentId}`)}
            variant="ghost"
            className="mb-4 gap-2"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Agent
          </Button>
          <div className="flex items-center gap-3">
            <Wallet className="h-8 w-8 text-primary" />
            <div>
              <h1 className="font-bold text-2xl">Fund Agent</h1>
              <p className="text-muted-foreground">
                Send USDC to {agent.displayName}
              </p>
            </div>
          </div>
        </div>

        {/* Current Balance Card */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 font-semibold">Current Balance</h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="text-muted-foreground text-sm">Agent Balance</p>
              <p className="font-mono font-semibold text-2xl">
                $
                {agent.balance?.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                }) ?? "0.00"}
              </p>
              <p className="text-muted-foreground text-xs">USDC</p>
            </div>
            <div className="rounded-lg bg-muted/50 p-4">
              <p className="text-muted-foreground text-sm">Your Balance</p>
              <p className="font-mono font-semibold text-2xl">
                $
                {userBalance?.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                }) ?? "0.00"}
              </p>
              <p className="text-muted-foreground text-xs">Available to send</p>
            </div>
          </div>
        </div>

        {/* Wallet Address Card */}
        {hasWallet ? (
          <div className="rounded-xl border border-border bg-card p-6">
            <h2 className="mb-4 font-semibold">Agent Wallet</h2>
            <div className="flex items-center gap-3 rounded-lg bg-muted/50 p-4">
              <div className="min-w-0 flex-1">
                <p className="text-muted-foreground text-xs">Polygon Address</p>
                <p className="truncate font-mono text-sm">
                  {agent.walletAddress}
                </p>
              </div>
              <button
                onClick={copyAddress}
                className="rounded-lg p-2 transition-colors hover:bg-muted"
              >
                {copied ? (
                  <CheckCircle className="h-5 w-5 text-green-500" />
                ) : (
                  <Copy className="h-5 w-5 text-muted-foreground" />
                )}
              </button>
              <a
                href={`https://polygonscan.com/address/${agent.walletAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded-lg p-2 transition-colors hover:bg-muted"
              >
                <ExternalLink className="h-5 w-5 text-muted-foreground" />
              </a>
            </div>
          </div>
        ) : (
          <div className="rounded-xl border border-yellow-500/50 bg-yellow-500/10 p-6">
            <div className="flex items-start gap-3">
              <AlertCircle className="h-5 w-5 text-yellow-500" />
              <div>
                <h3 className="font-semibold">Wallet Not Created</h3>
                <p className="text-muted-foreground text-sm">
                  This agent doesn't have a wallet yet. A wallet will be created
                  automatically when you fund the agent for the first time.
                </p>
              </div>
            </div>
          </div>
        )}

        {/* Send Funds Card */}
        <div className="rounded-xl border border-border bg-card p-6">
          <h2 className="mb-4 font-semibold">Send USDC</h2>
          <div className="space-y-4">
            <div>
              <label className="mb-2 block font-medium text-sm">
                Amount (USDC)
              </label>
              <div className="relative">
                <span className="absolute top-1/2 left-3 -translate-y-1/2 text-muted-foreground">
                  $
                </span>
                <input
                  type="number"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                  min="0"
                  step="0.01"
                  className="w-full rounded-lg border border-border bg-background py-3 pr-4 pl-8 text-lg focus:border-primary focus:outline-none"
                />
              </div>
              <div className="mt-2 flex gap-2">
                {[10, 50, 100, 500].map((preset) => (
                  <button
                    key={preset}
                    onClick={() => setAmount(preset.toString())}
                    className="rounded-lg border border-border px-3 py-1 text-sm transition-colors hover:bg-muted"
                  >
                    ${preset}
                  </button>
                ))}
              </div>
            </div>

            {userBalance !== null && parseFloat(amount) > userBalance && (
              <p className="text-red-500 text-sm">
                Insufficient balance. You have ${userBalance.toFixed(2)} USDC.
              </p>
            )}

            <Button
              onClick={handleSendFunds}
              disabled={isSending || !amount || parseFloat(amount) <= 0}
              className="w-full gap-2"
              size="lg"
            >
              {isSending ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Sending...
                </>
              ) : (
                <>
                  <Wallet className="h-4 w-4" />
                  Send USDC
                </>
              )}
            </Button>
          </div>
        </div>

        {/* External Funding Option */}
        {hasWallet && (
          <div className="rounded-xl border border-border border-dashed bg-card/50 p-6 text-center">
            <h3 className="mb-2 font-semibold">Fund Externally</h3>
            <p className="mb-4 text-muted-foreground text-sm">
              You can also send USDC directly to the agent's wallet address on
              Polygon network from any external wallet.
            </p>
            <div className="flex justify-center gap-2">
              <button
                onClick={copyAddress}
                className={cn(
                  "flex items-center gap-2 rounded-lg px-4 py-2 text-sm transition-colors",
                  "border border-border hover:bg-muted",
                )}
              >
                <Copy className="h-4 w-4" />
                Copy Address
              </button>
            </div>
          </div>
        )}
      </div>
    </PageContainer>
  );
}
