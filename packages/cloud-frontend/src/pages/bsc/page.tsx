"use client";

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared-brand";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CloudVideoBackground,
  DashboardErrorState,
  DashboardLoadingState,
  Input,
} from "@elizaos/ui";
import { CheckCircle2, Gift, ShieldCheck, Wallet, Zap } from "lucide-react";
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
  const bonusApplies = amountValue !== null && amountValue >= 10;
  const totalCredits =
    amountValue === null ? 0 : amountValue + (bonusApplies ? 5 : 0);
  const stats = [
    {
      label: "Minimum buy",
      value: "$10",
      helper: "USDT on BSC",
      icon: Wallet,
    },
    {
      label: "Bonus",
      value: "+$5",
      helper: "Cloud credit",
      icon: Gift,
    },
    {
      label: "Settlement",
      value: "On-chain",
      helper: "After confirmation",
      icon: ShieldCheck,
    },
  ];
  const steps = [
    {
      title: "Connect wallet",
      description: "Use the same wallet that is attached to your account.",
      icon: Wallet,
    },
    {
      title: "Pay USDT on BSC",
      description: "Send a normal wallet-to-wallet token transfer.",
      icon: Zap,
    },
    {
      title: "Credit posts",
      description: "Cloud credit is added after on-chain confirmation.",
      icon: CheckCircle2,
    },
  ];

  return (
    <>
      <Helmet>
        <title>BSC Cloud Credit Promotion</title>
        <meta
          name="description"
          content="Buy $10 or more in Eliza Cloud credit with BSC and receive $5 extra credit."
        />
      </Helmet>
      <CloudVideoBackground
        basePath={BRAND_PATHS.clouds}
        speed="4x"
        poster={BRAND_PATHS.poster}
        scrim={0.82}
        scrimColor="rgba(0,0,0,1)"
        overlay={<div className="absolute inset-0 bg-black/35 sm:hidden" />}
        className="theme-cloud min-h-screen bg-black text-white"
      >
        <main id="main" className="relative z-10 min-h-screen">
          <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-5 sm:px-6 lg:px-8">
            <header className="flex items-center justify-between gap-4">
              <Link
                to="/"
                className="inline-flex items-center transition-opacity hover:opacity-80"
                aria-label="Eliza Cloud home"
              >
                <img
                  src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudWhite}`}
                  alt="Eliza Cloud"
                  className="h-7 w-auto sm:h-8"
                  draggable={false}
                />
              </Link>
              <div className="hidden items-center gap-2 border border-white/14 bg-white/8 px-3 py-2 text-xs font-medium text-white/82 backdrop-blur-md sm:inline-flex">
                <Gift className="h-4 w-4 text-[#FF5800]" />
                BSC promotion
              </div>
            </header>

            <section className="grid flex-1 gap-8 pb-8 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start lg:pb-12">
              <div className="space-y-7 pt-8 lg:pt-20">
                <div className="space-y-5">
                  <div className="inline-flex items-center gap-2 border border-white/14 bg-black/45 px-3 py-2 text-xs font-medium text-white/74 backdrop-blur-md">
                    <Gift className="h-4 w-4 text-[#FF5800]" />
                    Limited BSC credit bonus
                  </div>
                  <div className="space-y-5">
                    <h1 className="max-w-3xl font-poppins text-5xl font-semibold leading-[0.96] text-white sm:text-6xl lg:text-7xl">
                      Buy cloud credit on BSC
                    </h1>
                    <p className="max-w-2xl text-base leading-7 text-white/72 sm:text-lg">
                      Add at least $10 in Eliza Cloud credit with a verified BSC
                      wallet payment and receive an extra $5 credit from BSC.
                    </p>
                  </div>
                </div>

                <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
                  {stats.map(({ label, value, helper, icon: Icon }) => (
                    <Card
                      key={label}
                      className="border-white/12 bg-black/48 text-white shadow-none backdrop-blur-md"
                      variant="flat"
                    >
                      <CardContent className="p-4">
                        <div className="flex items-center gap-2 text-xs font-medium text-white/58">
                          <Icon className="h-4 w-4 text-[#FF5800]" />
                          {label}
                        </div>
                        <div className="mt-3 text-2xl font-semibold text-white">
                          {value}
                        </div>
                        <div className="mt-1 text-xs text-white/54">
                          {helper}
                        </div>
                      </CardContent>
                    </Card>
                  ))}
                </div>
              </div>

              <div className="space-y-4 lg:sticky lg:top-6 lg:pt-10">
                {!isReady || (isAuthenticated && isLoading) ? (
                  <DashboardLoadingState label="Loading account" />
                ) : isError ? (
                  <DashboardErrorState
                    message={
                      (error as Error)?.message ?? "Failed to load account"
                    }
                  />
                ) : !user ? (
                  <Card className="border-white/12 bg-black/78 text-white shadow-2xl backdrop-blur-xl">
                    <CardContent className="space-y-4 p-5">
                      <p className="text-sm leading-6 text-white/70">
                        Sign in before paying so the credit can be attached to
                        your account.
                      </p>
                      <Button asChild className="w-full">
                        <Link to="/login?returnTo=%2Fbsc">Sign in</Link>
                      </Button>
                    </CardContent>
                  </Card>
                ) : (
                  <>
                    <Card className="border-white/12 bg-black/78 text-white shadow-2xl backdrop-blur-xl">
                      <CardHeader className="flex-row items-start justify-between gap-4 space-y-0 p-5 pb-4">
                        <div>
                          <CardTitle className="text-lg text-white">
                            Credit amount
                          </CardTitle>
                          <p className="mt-1 text-sm text-white/62">
                            BSC bonus applies at $10 or more.
                          </p>
                        </div>
                        <div className="border border-[#FF5800]/35 bg-[#FF5800]/14 px-3 py-2 text-right text-xs font-medium text-[#FFB087]">
                          +$5 bonus
                        </div>
                      </CardHeader>
                      <CardContent className="space-y-4 border-t border-white/10 p-5">
                        <label
                          className="block space-y-2"
                          htmlFor="bsc-credit-amount"
                        >
                          <span className="text-xs font-medium text-white/58">
                            Cloud credit purchase
                          </span>
                          <div className="flex items-center border border-white/14 bg-white/[0.06]">
                            <span className="px-3 text-white/56">$</span>
                            <Input
                              id="bsc-credit-amount"
                              type="number"
                              min={10}
                              max={10000}
                              value={amount}
                              onChange={(event) =>
                                setAmount(event.target.value)
                              }
                              variant="config"
                              density="relaxed"
                              className="border-0 bg-transparent px-0 text-base text-white focus:border-0 focus:ring-0"
                            />
                          </div>
                        </label>
                        <div className="grid grid-cols-2 gap-3 text-sm">
                          <div className="border border-white/10 bg-white/[0.05] p-3">
                            <p className="text-xs text-white/52">You pay</p>
                            <p className="mt-1 text-lg font-semibold text-white">
                              ${amountValue?.toFixed(2) ?? "0.00"}
                            </p>
                          </div>
                          <div className="border border-[#FF5800]/28 bg-[#FF5800]/12 p-3">
                            <p className="text-xs text-[#FFB087]">
                              Cloud credit
                            </p>
                            <p className="mt-1 text-lg font-semibold text-white">
                              {totalCredits.toFixed(2)} credits
                            </p>
                          </div>
                        </div>
                        {amountValue !== null && amountValue < 10 && (
                          <p className="text-xs text-[#FFB087]">
                            The BSC bonus starts at $10.
                          </p>
                        )}
                      </CardContent>
                    </Card>
                    <DirectCryptoCreditCard
                      amount={amountValue}
                      promoCode="bsc"
                      status={status}
                      accountWalletAddress={user.wallet_address ?? null}
                      surface="cloud"
                      onSuccess={() => undefined}
                    />
                  </>
                )}
              </div>
            </section>

            <section className="grid gap-3 border-t border-white/12 py-6 sm:grid-cols-3">
              {steps.map(({ title, description, icon: Icon }) => (
                <Card
                  key={title}
                  className="min-h-[132px] border-white/10 bg-black/48 text-white shadow-none backdrop-blur-md"
                  variant="flat"
                >
                  <CardContent className="flex gap-4 p-4">
                    <div className="flex size-10 shrink-0 items-center justify-center border border-white/12 bg-white/[0.06] text-[#FF5800]">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-sm font-semibold text-white">
                        {title}
                      </h2>
                      <p className="mt-2 text-sm leading-6 text-white/62">
                        {description}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))}
            </section>
          </div>
        </main>
      </CloudVideoBackground>
    </>
  );
}
