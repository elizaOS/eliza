"use client";

import {
  BrandButton,
  BrandCard,
  DashboardErrorState,
  DashboardLoadingState,
  DashboardStatCard,
  ElizaCloudLockup,
  Input,
  SectionHeader,
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
      <main
        id="main"
        className="min-h-screen bg-bg text-txt [background-image:linear-gradient(180deg,var(--bg),var(--background))]"
      >
        <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-8 px-4 py-6 sm:px-6 lg:px-8">
          <header className="flex items-center justify-between gap-4 border-b border-border pb-5">
            <Link
              to="/"
              className="inline-flex text-txt-strong transition-colors hover:text-accent"
              aria-label="Eliza Cloud home"
            >
              <ElizaCloudLockup />
            </Link>
            <div className="hidden items-center gap-2 rounded-sm border border-warn/25 bg-warn-subtle px-3 py-2 text-xs font-medium uppercase text-warn sm:inline-flex">
              <Gift className="h-4 w-4" />
              BSC promotion
            </div>
          </header>

          <section className="grid flex-1 gap-8 lg:grid-cols-[minmax(0,1fr)_440px] lg:items-start">
            <div className="space-y-6 pt-4 lg:pt-10">
              <SectionHeader
                label="BSC promotion"
                title="Buy cloud credit on BSC"
                description="Add at least $10 in Eliza Cloud credit with a verified BSC wallet payment and receive an extra $5 credit from BSC."
                className="mb-0"
                labelClassName="text-sm tracking-[0.2em] text-warn"
                titleClassName="mb-4 max-w-3xl text-4xl font-semibold uppercase leading-tight md:text-6xl"
                descriptionClassName="max-w-2xl text-base leading-7 text-muted-foreground md:text-base"
              />

              <div className="grid max-w-2xl gap-3 sm:grid-cols-3">
                <DashboardStatCard
                  label="Minimum buy"
                  value="$10"
                  helper="USDT on BSC"
                  accent="amber"
                  icon={<Wallet className="h-5 w-5" />}
                />
                <DashboardStatCard
                  label="Bonus"
                  value="+$5"
                  helper="Cloud credit"
                  accent="orange"
                  icon={<Gift className="h-5 w-5" />}
                />
                <DashboardStatCard
                  label="Settlement"
                  value="On-chain"
                  helper="Credited after confirmation"
                  accent="white"
                  icon={<ShieldCheck className="h-5 w-5" />}
                  valueClassName="text-lg md:text-xl"
                />
              </div>
            </div>

            <div className="space-y-4 lg:sticky lg:top-6">
              {!isReady || (isAuthenticated && isLoading) ? (
                <DashboardLoadingState label="Loading account" />
              ) : isError ? (
                <DashboardErrorState
                  message={
                    (error as Error)?.message ?? "Failed to load account"
                  }
                />
              ) : !user ? (
                <BrandCard className="space-y-4">
                  <p className="text-sm leading-6 text-muted-foreground">
                    Sign in before paying so the credit can be attached to your
                    account.
                  </p>
                  <BrandButton asChild>
                    <Link to="/login?returnTo=%2Fbsc">Sign in</Link>
                  </BrandButton>
                </BrandCard>
              ) : (
                <>
                  <BrandCard className="space-y-4">
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <h2 className="text-lg font-semibold text-txt-strong">
                          Credit amount
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                          BSC bonus applies at $10 or more.
                        </p>
                      </div>
                      <div className="rounded-sm border border-warn/25 bg-warn-subtle px-3 py-2 text-right text-xs uppercase text-warn">
                        +$5 bonus
                      </div>
                    </div>
                    <label
                      className="block space-y-2"
                      htmlFor="bsc-credit-amount"
                    >
                      <span className="text-xs font-medium uppercase text-muted-foreground">
                        Cloud credit purchase
                      </span>
                      <div className="flex items-center rounded-sm border border-input bg-bg">
                        <span className="px-3 text-muted-foreground">$</span>
                        <Input
                          id="bsc-credit-amount"
                          type="number"
                          min={10}
                          max={10000}
                          value={amount}
                          onChange={(event) => setAmount(event.target.value)}
                          variant="config"
                          density="relaxed"
                          className="border-0 bg-transparent px-0 text-base text-txt-strong focus:border-0 focus:ring-0"
                        />
                      </div>
                    </label>
                    <div className="grid grid-cols-2 gap-3 text-sm">
                      <div className="rounded-sm border border-border bg-bg-muted p-3">
                        <p className="text-xs uppercase text-muted-foreground">
                          You pay
                        </p>
                        <p className="mt-1 text-lg font-semibold text-txt-strong">
                          ${amountValue?.toFixed(2) ?? "0.00"}
                        </p>
                      </div>
                      <div className="rounded-sm border border-warn/25 bg-warn-subtle p-3">
                        <p className="text-xs uppercase text-warn">
                          Cloud credit
                        </p>
                        <p className="mt-1 text-lg font-semibold text-txt-strong">
                          {totalCredits.toFixed(2)} credits
                        </p>
                      </div>
                    </div>
                    {amountValue !== null && amountValue < 10 && (
                      <p className="text-xs text-warn">
                        The BSC bonus starts at $10.
                      </p>
                    )}
                  </BrandCard>
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

          <section className="grid gap-3 border-t border-border pt-6 sm:grid-cols-3">
            {steps.map(({ title, description, icon: Icon }) => (
              <BrandCard
                key={title}
                corners={false}
                className="flex min-h-[132px] gap-4 p-4"
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-sm border border-accent/20 bg-accent-subtle text-accent">
                  <Icon className="h-5 w-5" />
                </div>
                <div className="min-w-0">
                  <h2 className="text-sm font-semibold uppercase text-txt-strong">
                    {title}
                  </h2>
                  <p className="mt-2 text-sm leading-6 text-muted-foreground">
                    {description}
                  </p>
                </div>
              </BrandCard>
            ))}
          </section>
        </div>
      </main>
    </>
  );
}
