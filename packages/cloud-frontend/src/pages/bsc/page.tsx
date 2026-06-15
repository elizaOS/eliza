"use client";

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DashboardErrorState,
  Input,
} from "@elizaos/ui";
import { Gift } from "lucide-react";
import { lazy, Suspense, useEffect, useState } from "react";
import { Helmet } from "react-helmet-async";
import { Link } from "react-router-dom";
import type { CryptoStatusResponse } from "@/lib/types/crypto-status";
import { useT } from "@/providers/I18nProvider";
import { useUserProfile } from "../../lib/data/user";

const LazyDirectCryptoCreditCard = lazy(async () => {
  const mod = await import(
    "../../dashboard/billing/_components/direct-crypto-credit-card"
  );
  return { default: mod.DirectCryptoCreditCard };
});

export default function BscPromoPage() {
  const t = useT();
  const { user, isReady, isAuthenticated, isLoading, isError, error } =
    useUserProfile();
  const [amount, setAmount] = useState("10");
  const [status, setStatus] = useState<CryptoStatusResponse | null>(null);

  // `/api/crypto/status` is a public endpoint (no auth required). Firing it on
  // mount instead of after `useUserProfile` resolves cuts a serial roundtrip:
  // by the time the user-profile fetch finishes, status is usually already in
  // hand, so DirectCryptoCreditCard doesn't flash an empty/"not configured"
  // state.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const response = await fetch("/api/crypto/status");
      if (cancelled || !response.ok) return;
      // Guard against the SPA fallback serving index.html for unknown /api/*
      // paths.
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("application/json")) return;
      const data = (await response.json()) as CryptoStatusResponse;
      if (!cancelled) setStatus(data);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const parsed = Number.parseFloat(amount);
  const amountValue = Number.isFinite(parsed) ? parsed : null;
  const bonusApplies = amountValue !== null && amountValue >= 10;
  const totalCredits =
    amountValue === null ? 0 : amountValue + (bonusApplies ? 5 : 0);

  return (
    <>
      <Helmet>
        <title>
          {t("cloud.bsc.metaTitle", {
            defaultValue: "BSC Cloud Credit Promotion",
          })}
        </title>
        <meta
          name="description"
          content={t("cloud.bsc.metaDescription", {
            defaultValue:
              "Buy $10 or more in Eliza Cloud credit with BSC and receive $5 extra credit.",
          })}
        />
      </Helmet>
      <div
        className="theme-clouds min-h-screen bg-white font-poppins text-black"
        style={{ background: "var(--background)" }}
      >
        <main
          id="main"
          className="relative z-10 mx-auto flex min-h-screen w-full max-w-5xl flex-col px-5 py-6 sm:px-8"
        >
          <header className="flex items-center justify-between">
            <Link
              to="/"
              className="inline-flex items-center transition-opacity hover:opacity-80"
              aria-label={t("cloud.bsc.homeAria", {
                defaultValue: "Eliza Cloud home",
              })}
            >
              <img
                src={`${BRAND_PATHS.logos}/${LOGO_FILES.cloudBlack}`}
                alt="Eliza Cloud"
                className="h-8 w-auto"
                draggable={false}
              />
            </Link>
          </header>

          <section className="grid flex-1 gap-8 py-10 lg:grid-cols-[minmax(0,1fr)_420px] lg:items-center lg:py-16">
            <div className="max-w-2xl">
              <h1 className="text-5xl font-semibold leading-[0.95] text-black sm:text-6xl lg:text-7xl">
                {t("cloud.bsc.heading", {
                  defaultValue: "Buy cloud credit on BSC",
                })}
              </h1>
              <p className="mt-5 inline-flex items-center gap-2 rounded-xs border border-black/14 bg-white/72 px-3 py-2 text-sm font-medium text-black backdrop-blur-sm">
                <Gift className="size-4" />
                {t("cloud.bsc.bonusBadge", {
                  defaultValue: "$10+ in BSC = $5 bonus credit",
                })}
              </p>
            </div>

            <div className="space-y-4">
              {/*
                Cloud credit summary is static (amount input + derived "you
                pay / you receive") — nothing in it depends on auth state, the
                user profile, or the crypto-status fetch. Render it on first
                paint so the form is interactable immediately, instead of
                blanking the right column for ~5s while user-profile +
                crypto-status round-trip. The auth/wallet panel below it
                streams in as data arrives.
              */}
              <Card className="rounded-xs border-black/12 bg-white/88 text-black shadow-xl backdrop-blur-md">
                <CardHeader className="p-5 pb-4">
                  <CardTitle className="text-lg text-black">
                    {t("cloud.bsc.topUp", { defaultValue: "Top up credit" })}
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-4 border-t border-black/10 p-5">
                  <label
                    className="block space-y-2"
                    htmlFor="bsc-credit-amount"
                  >
                    <span className="text-xs font-medium text-black/62">
                      {t("cloud.bsc.purchaseAmount", {
                        defaultValue: "Purchase amount",
                      })}
                    </span>
                    <div className="flex items-center rounded-xs border border-black/14 bg-white">
                      <span className="px-3 text-black/56">$</span>
                      <Input
                        id="bsc-credit-amount"
                        type="number"
                        min={10}
                        max={10000}
                        value={amount}
                        onChange={(event) => setAmount(event.target.value)}
                        variant="config"
                        density="relaxed"
                        className="border-0 bg-transparent px-0 text-base text-black focus:border-0 focus:ring-0"
                      />
                    </div>
                  </label>
                  {/* One-tap presets — every option meets the $10 promo
                      threshold so picking any of them keeps the +$5 bonus. */}
                  <div className="flex flex-wrap gap-2">
                    {[10, 25, 50, 100].map((preset) => {
                      const active = amountValue === preset;
                      return (
                        <button
                          key={preset}
                          type="button"
                          onClick={() => setAmount(String(preset))}
                          aria-pressed={active}
                          className={`min-w-[56px] rounded-xs border px-3 py-1.5 text-sm font-medium transition-colors ${
                            active
                              ? "border-black bg-black text-white"
                              : "border-black/14 bg-white text-black/72 hover:bg-black/[0.04] hover:text-black"
                          }`}
                        >
                          ${preset}
                        </button>
                      );
                    })}
                  </div>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="rounded-xs border border-black/10 bg-black/[0.03] p-3">
                      <p className="text-xs text-black/58">
                        {t("cloud.bsc.youPay", { defaultValue: "You pay" })}
                      </p>
                      <p className="mt-1 text-lg font-semibold text-black">
                        ${amountValue?.toFixed(2) ?? "0.00"}
                      </p>
                    </div>
                    <div className="rounded-xs border border-black/10 bg-black/[0.03] p-3">
                      <p className="text-xs text-black/58">
                        {t("cloud.bsc.youReceive", {
                          defaultValue: "You receive",
                        })}
                      </p>
                      <p className="mt-1 text-lg font-semibold text-black">
                        {t("cloud.bsc.credits", {
                          amount: totalCredits.toFixed(2),
                          defaultValue: "{{amount}} credits",
                        })}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>

              {/* Auth-gated panel below the static form. While the user
                  profile resolves we show a card-shaped skeleton, sized to
                  roughly match the final wallet/sign-in card so layout
                  doesn't jank in. */}
              {!isReady || (isAuthenticated && isLoading) ? (
                <Card
                  aria-busy="true"
                  className="rounded-xs border-black/12 bg-white/88 text-black shadow-xl backdrop-blur-md"
                >
                  <CardContent className="space-y-3 p-5">
                    <div className="h-4 w-32 animate-pulse rounded-xs bg-black/10" />
                    <div className="h-3 w-64 max-w-full animate-pulse rounded-xs bg-black/8" />
                    <div className="mt-2 h-10 w-full animate-pulse rounded-xs bg-black/10" />
                  </CardContent>
                </Card>
              ) : isError ? (
                <DashboardErrorState
                  message={
                    (error as Error)?.message ??
                    t("cloud.bsc.loadAccountFailed", {
                      defaultValue: "Failed to load account",
                    })
                  }
                />
              ) : !user ? (
                <Card className="rounded-xs border-black/12 bg-white/88 text-black shadow-xl backdrop-blur-md">
                  <CardContent className="space-y-4 p-5">
                    <p className="text-sm leading-6 text-black/68">
                      {t("cloud.bsc.signInFirst", {
                        defaultValue:
                          "Sign in first so we know whose account to credit.",
                      })}
                    </p>
                    <Button asChild className="w-full rounded-xs">
                      <Link to="/login?returnTo=%2Fbsc">
                        {t("cloud.bsc.signIn", { defaultValue: "Sign in" })}
                      </Link>
                    </Button>
                  </CardContent>
                </Card>
              ) : (
                <Suspense
                  fallback={
                    <Card
                      aria-busy="true"
                      className="rounded-xs border-black/12 bg-white/88 text-black shadow-xl backdrop-blur-md"
                    >
                      <CardContent className="space-y-3 p-5">
                        <div className="h-4 w-40 animate-pulse rounded-xs bg-black/10" />
                        <div className="h-3 w-56 max-w-full animate-pulse rounded-xs bg-black/8" />
                        <div className="mt-2 h-10 w-full animate-pulse rounded-xs bg-black/10" />
                      </CardContent>
                    </Card>
                  }
                >
                  <LazyDirectCryptoCreditCard
                    amount={amountValue}
                    promoCode="bsc"
                    status={status}
                    accountWalletAddress={user.wallet_address ?? null}
                    surface="cloud"
                    lockedNetwork="bsc"
                    onSuccess={() => undefined}
                  />
                </Suspense>
              )}
            </div>
          </section>
        </main>
      </div>
    </>
  );
}
