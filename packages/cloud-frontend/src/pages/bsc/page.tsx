"use client";

import { DashboardErrorState, DashboardLoadingState } from "@elizaos/ui";
import { Gift, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import type { CryptoStatusResponse } from "@/lib/types/crypto-status";
import { DirectCryptoCreditCard } from "../../dashboard/billing/_components/direct-crypto-credit-card";
import { useUserProfile } from "../../lib/data/user";

export default function BscPromoPage() {
  const { user, isReady, isAuthenticated, isLoading, isError, error } =
    useUserProfile();
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState<CryptoStatusResponse | null>(null);

  const fetchCryptoStatus = useCallback(async () => {
    const response = await fetch("/api/crypto/status");
    if (!response.ok) return;
    // Guard against the SPA fallback serving index.html for unknown /api/* paths.
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return;
    setStatus(await response.json());
  }, []);

  useEffect(() => {
    fetchCryptoStatus();
  }, [fetchCryptoStatus]);

  const parsed = Number.parseFloat(amount);
  const amountValue = Number.isFinite(parsed) ? parsed : null;

  return (
    <>
      <Helmet>
        <title>BSC Cloud Credit Promotion</title>
        <meta
          name="description"
          content="Buy $10 or more in Eliza Cloud credit with BSC and receive $5 extra credit."
        />
      </Helmet>
      <main className="min-h-screen bg-[#050505] text-white">
        <div className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-5 py-10">
          <Link
            to="/"
            className="font-mono text-sm uppercase text-white/60 hover:text-white"
          >
            eliza cloud
          </Link>

          <section className="grid gap-8 lg:grid-cols-[1fr_420px] lg:items-start">
            <div className="space-y-6 pt-6">
              <div className="inline-flex items-center gap-2 border border-[#FF5800]/40 bg-[#FF5800]/10 px-3 py-2 font-mono text-xs uppercase text-[#ffb088]">
                <Gift className="h-4 w-4" />
                BSC promotion
              </div>
              <div className="space-y-4">
                <h1 className="max-w-3xl font-mono text-4xl font-semibold uppercase tracking-normal text-white md:text-6xl">
                  Buy cloud credit on BSC
                </h1>
                <p className="max-w-2xl text-base leading-7 text-white/68">
                  Add at least $10 in Eliza Cloud credit with a verified BSC
                  wallet payment and receive an extra $5 credit from BSC.
                </p>
              </div>
              <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
                {[
                  "Connect wallet",
                  "Pay USDT on BSC",
                  "Credits post after confirmation",
                ].map((item) => (
                  <div
                    key={item}
                    className="border border-white/10 bg-white/[0.03] p-4"
                  >
                    <Wallet className="mb-3 h-4 w-4 text-[#FF5800]" />
                    <p className="font-mono text-xs uppercase text-white/72">
                      {item}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-4 border border-white/10 bg-white/[0.03] p-4">
              {!isReady || (isAuthenticated && isLoading) ? (
                <DashboardLoadingState label="Loading account" />
              ) : isError ? (
                <DashboardErrorState
                  message={
                    (error as Error)?.message ?? "Failed to load account"
                  }
                />
              ) : !user ? (
                <div className="space-y-4 p-4">
                  <p className="font-mono text-sm text-white/72">
                    Sign in before paying so the credit can be attached to your
                    account.
                  </p>
                  <Link
                    to="/login?returnTo=%2Fbsc"
                    className="inline-flex bg-[#e1e1e1] px-5 py-2.5 font-mono text-sm font-medium text-black hover:bg-white"
                  >
                    Sign in
                  </Link>
                </div>
              ) : (
                <>
                  <label className="block space-y-2">
                    <span className="font-mono text-xs uppercase text-white/50">
                      Credit amount
                    </span>
                    <div className="flex items-center border border-white/15 bg-black/40 px-3">
                      <span className="font-mono text-white/50">$</span>
                      <input
                        type="number"
                        min={10}
                        max={10000}
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        className="h-11 flex-1 bg-transparent px-2 font-mono text-white outline-none"
                      />
                    </div>
                  </label>
                  {amountValue !== null && amountValue < 10 && (
                    <p className="font-mono text-xs text-amber-200">
                      The BSC bonus starts at $10.
                    </p>
                  )}
                  <DirectCryptoCreditCard
                    amount={amountValue}
                    promoCode="bsc"
                    status={status}
                    accountWalletAddress={user.wallet_address ?? null}
                    onSuccess={() => undefined}
                  />
                </>
              )}
            </div>
          </section>
        </div>
      </main>
    </>
  );
}
