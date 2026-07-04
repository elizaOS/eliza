/**
 * BSC cloud-credit promotion (public). Buy $10+ in cloud credit on BSC, get $5
 * bonus.
 *
 * The static credit calculator (amount input + you-pay / you-receive) and the
 * sign-in gate are ported here. The actual crypto-checkout card
 * (`DirectCryptoCreditCard`) lives in the BILLING domain (it pulls the wallet
 * stack — wagmi / RainbowKit / Solana — which are not dependencies of
 * `@elizaos/ui`), and the account/profile fetch (`useUserProfile`) lives in the
 * SETTINGS domain. Signed-in users see a link into the in-app billing surface
 * instead of an inline crypto-checkout card.
 */

import { BRAND_PATHS, LOGO_FILES } from "@elizaos/shared/brand";
import { Gift } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
} from "../../../components/primitives";
import { useSessionAuth } from "../../lib/use-session-auth";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { usePageTitle } from "../lib/use-page-title";

export default function BscPromoPage() {
  const t = useCloudT();
  const { ready, authenticated } = useSessionAuth();
  const [amount, setAmount] = useState("10");

  usePageTitle(
    t("cloud.bsc.metaTitle", { defaultValue: "BSC Cloud Credit Promotion" }),
  );

  const parsed = Number.parseFloat(amount);
  const amountValue = Number.isFinite(parsed) ? parsed : null;
  const bonusApplies = amountValue !== null && amountValue >= 10;
  const totalCredits =
    amountValue === null ? 0 : amountValue + (bonusApplies ? 5 : 0);

  return (
    <div className="theme-clouds min-h-[100dvh] bg-bg font-sans text-txt">
      <main
        id="main"
        className="relative z-10 mx-auto flex min-h-[100dvh] w-full max-w-5xl flex-col px-5 py-6 sm:px-8"
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
            <h1 className="text-5xl font-semibold leading-[0.95] text-txt sm:text-6xl lg:text-7xl">
              {t("cloud.bsc.heading", {
                defaultValue: "Buy cloud credit on BSC",
              })}
            </h1>
            <p className="mt-5 inline-flex items-center gap-2 rounded-xs border border-border bg-surface px-3 py-2 text-sm font-medium text-txt">
              <Gift className="size-4" />
              {t("cloud.bsc.bonusBadge", {
                defaultValue: "$10+ in BSC = $5 bonus credit",
              })}
            </p>
          </div>

          <div className="space-y-4">
            <Card className="rounded-xs border-border bg-card text-txt">
              <CardHeader className="p-5 pb-4">
                <CardTitle className="text-lg text-txt">
                  {t("cloud.bsc.topUp", { defaultValue: "Top up credit" })}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4 border-t border-border p-5">
                <label className="block space-y-2" htmlFor="bsc-credit-amount">
                  <span className="text-xs font-medium text-muted">
                    {t("cloud.bsc.purchaseAmount", {
                      defaultValue: "Purchase amount",
                    })}
                  </span>
                  <div className="flex items-center rounded-xs border border-border bg-bg">
                    <span className="px-3 text-muted">$</span>
                    <Input
                      id="bsc-credit-amount"
                      type="number"
                      min={10}
                      max={10000}
                      value={amount}
                      onChange={(event) => setAmount(event.target.value)}
                      className="border-0 bg-transparent px-0 text-base text-txt"
                    />
                  </div>
                </label>
                <div className="flex flex-wrap gap-2">
                  {[10, 25, 50, 100].map((preset) => {
                    const active = amountValue === preset;
                    return (
                      <Button
                        variant="ghost"
                        key={preset}
                        type="button"
                        onClick={() => setAmount(String(preset))}
                        aria-pressed={active}
                        className={`min-w-[56px] rounded-xs border px-3 py-1.5 text-sm font-medium transition-colors ${
                          active
                            ? "border-accent bg-accent text-accent-foreground"
                            : "border-border bg-card text-muted hover:bg-bg-hover hover:text-txt"
                        }`}
                      >
                        ${preset}
                      </Button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded-xs border border-border bg-surface p-3">
                    <p className="text-xs text-muted">
                      {t("cloud.bsc.youPay", { defaultValue: "You pay" })}
                    </p>
                    <p className="mt-1 text-lg font-semibold text-txt">
                      ${amountValue?.toFixed(2) ?? "0.00"}
                    </p>
                  </div>
                  <div className="rounded-xs border border-border bg-surface p-3">
                    <p className="text-xs text-muted">
                      {t("cloud.bsc.youReceive", {
                        defaultValue: "You receive",
                      })}
                    </p>
                    <p className="mt-1 text-lg font-semibold text-txt">
                      {t("cloud.bsc.credits", {
                        amount: totalCredits.toFixed(2),
                        defaultValue: "{{amount}} credits",
                      })}
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>

            {!ready ? (
              <Card
                aria-busy="true"
                className="rounded-xs border-border bg-card text-txt"
              >
                <CardContent className="space-y-3 p-5">
                  <div className="h-4 w-32 animate-pulse rounded-xs bg-bg-muted motion-reduce:animate-none" />
                  <div className="h-3 w-64 max-w-full animate-pulse rounded-xs bg-bg-muted motion-reduce:animate-none" />
                  <div className="mt-2 h-10 w-full animate-pulse rounded-xs bg-bg-muted motion-reduce:animate-none" />
                </CardContent>
              </Card>
            ) : !authenticated ? (
              <Card className="rounded-xs border-border bg-card text-txt">
                <CardContent className="space-y-4 p-5">
                  <p className="text-sm leading-6 text-muted-strong">
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
              <Card className="rounded-xs border-border bg-card text-txt">
                <CardContent className="space-y-4 p-5">
                  <p className="text-sm leading-6 text-muted-strong">
                    {t("cloud.bsc.checkoutInApp", {
                      defaultValue:
                        "Continue your BSC credit purchase from the billing settings.",
                    })}
                  </p>
                  <Button asChild className="w-full rounded-xs">
                    <Link to="/settings#cloud-billing">
                      {t("cloud.bsc.openBilling", {
                        defaultValue: "Open billing",
                      })}
                    </Link>
                  </Button>
                </CardContent>
              </Card>
            )}
          </div>
        </section>
      </main>
    </div>
  );
}
