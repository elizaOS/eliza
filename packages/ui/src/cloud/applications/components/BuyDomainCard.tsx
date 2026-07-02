/**
 * Application detail — Domains tab: search + price-quote + buy a domain through
 * Cloudflare (#10246).
 *
 * Calls `POST /api/v1/apps/:id/domains/check` for an availability + price quote,
 * then `POST /api/v1/apps/:id/domains/buy` behind an explicit confirm. The buy is
 * charged from the org's credit balance; a 402 surfaces a top-up CTA routed to
 * the system browser via `openExternalUrl` (never an in-webview checkout). The
 * quote shows the annual renewal price the renewal cron will re-charge.
 */

import {
  AlertTriangle,
  CheckCircle2,
  CreditCard,
  Loader2,
  Search,
  ShoppingCart,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { openExternalUrl } from "../../../utils/openExternalUrl";
import { ApiError, api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { resolveCloudConsoleUrl } from "../lib/native-cloud-nav";

interface DomainCheckResponse {
  success: boolean;
  domain: string;
  available: boolean;
  currency?: string;
  price?: { totalUsdCents: number };
  renewal?: { totalUsdCents: number };
}

interface DomainBuyResponse {
  success: boolean;
  domain: string;
  status?: string;
  pendingZoneProvisioning?: boolean;
}

const DOMAIN_RE = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

function formatUsd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

export interface BuyDomainCardProps {
  appId: string;
  onPurchased: () => void | Promise<void>;
}

export function BuyDomainCard({ appId, onPurchased }: BuyDomainCardProps) {
  const t = useCloudT();
  const [query, setQuery] = useState("");
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<DomainCheckResponse | null>(null);
  const [buying, setBuying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsCredits, setNeedsCredits] = useState(false);

  const normalized = query.trim().toLowerCase().replace(/\.$/, "");
  const isValid = DOMAIN_RE.test(normalized);

  async function handleCheck() {
    if (!isValid || checking) return;
    setChecking(true);
    setError(null);
    setResult(null);
    setNeedsCredits(false);
    try {
      const data = await api<DomainCheckResponse>(
        `/api/v1/apps/${appId}/domains/check`,
        { method: "POST", json: { domain: normalized } },
      );
      setResult(data);
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("cloud.appDomains.buyCheckFailed", {
              defaultValue: "Could not check that domain. Try again.",
            }),
      );
    } finally {
      setChecking(false);
    }
  }

  async function handleBuy() {
    if (!result?.available || buying) return;
    setBuying(true);
    setError(null);
    setNeedsCredits(false);
    try {
      const data = await api<DomainBuyResponse>(
        `/api/v1/apps/${appId}/domains/buy`,
        { method: "POST", json: { domain: normalized } },
      );
      toast.success(
        t("cloud.appDomains.buySuccess", { defaultValue: "Domain purchased" }),
        {
          description: data.pendingZoneProvisioning
            ? t("cloud.appDomains.buyProvisioning", {
                defaultValue:
                  "Setting up DNS — it may take a few minutes to go live.",
              })
            : t("cloud.appDomains.buyLive", {
                defaultValue: "Connecting it to your app now.",
              }),
        },
      );
      setQuery("");
      setResult(null);
      await onPurchased();
    } catch (e) {
      if (e instanceof ApiError && e.status === 402) {
        setNeedsCredits(true);
        setError(
          e.message ||
            t("cloud.appDomains.buyInsufficient", {
              defaultValue: "Not enough credits to buy this domain.",
            }),
        );
      } else if (e instanceof ApiError && e.status === 409) {
        setResult(null);
        setError(
          e.message ||
            t("cloud.appDomains.buyUnavailable", {
              defaultValue: "That domain is no longer available.",
            }),
        );
      } else {
        setError(
          e instanceof Error
            ? e.message
            : t("cloud.appDomains.buyFailed", {
                defaultValue: "Purchase failed. You were not charged.",
              }),
        );
      }
    } finally {
      setBuying(false);
    }
  }

  function openBilling() {
    // Resolve the real cloud console host from boot config, NOT
    // window.location.origin — on the native Applications studio the WebView
    // origin is `https://localhost` (Capacitor) / the Electrobun scheme, so an
    // origin-relative URL would dead-end at the device instead of Eliza Cloud
    // billing. resolveCloudConsoleUrl is correct on web + native.
    void openExternalUrl(resolveCloudConsoleUrl("/settings#cloud-billing"));
  }

  return (
    <div className="bg-neutral-900 rounded-sm p-4 space-y-4">
      <div>
        <h3 className="text-sm font-medium text-white flex items-center gap-2">
          <ShoppingCart className="h-4 w-4 text-[#FF5800]" />
          {t("cloud.appDomains.buyTitle", { defaultValue: "Buy a Domain" })}
        </h3>
        <p className="text-xs text-neutral-500 mt-1">
          {t("cloud.appDomains.buySubtitle", {
            defaultValue:
              "Register a new domain through Cloudflare and connect it to this app.",
          })}
        </p>
      </div>

      <form
        className="flex flex-col sm:flex-row gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void handleCheck();
        }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("cloud.appDomains.buyPlaceholder", {
            defaultValue: "yourbrand.com",
          })}
          aria-label={t("cloud.appDomains.buyInputLabel", {
            defaultValue: "Domain to buy",
          })}
          className="bg-black/40 border-neutral-800 text-white"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
        />
        <Button
          type="submit"
          size="sm"
          disabled={!isValid || checking}
          className="bg-[#FF5800] hover:bg-[#e54f00] text-white rounded-sm shrink-0"
        >
          {checking ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Search className="h-4 w-4" />
          )}
          <span className="ml-1.5">
            {t("cloud.appDomains.buyCheck", { defaultValue: "Check" })}
          </span>
        </Button>
      </form>

      {result && !result.available && (
        <div className="flex items-center gap-2 p-3 rounded-sm bg-black/40 text-sm text-neutral-300">
          <XCircle className="h-4 w-4 text-neutral-500 shrink-0" />
          <span>
            {t("cloud.appDomains.buyTaken", {
              defaultValue: "{{domain}} is not available.",
              domain: result.domain,
            })}
          </span>
        </div>
      )}

      {result?.available && result.price && (
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3 rounded-sm bg-black/40">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <CheckCircle2 className="h-4 w-4 text-[#FF5800] shrink-0" />
              <span className="text-sm font-medium text-white truncate">
                {result.domain}
              </span>
            </div>
            <p className="text-xs text-neutral-400 mt-1">
              {t("cloud.appDomains.buyPriceLine", {
                defaultValue: "{{price}}/yr",
                price: formatUsd(result.price.totalUsdCents),
              })}
              {result.renewal && (
                <span className="text-neutral-500">
                  {" · "}
                  {t("cloud.appDomains.buyRenewsLine", {
                    defaultValue: "renews {{price}}/yr",
                    price: formatUsd(result.renewal.totalUsdCents),
                  })}
                </span>
              )}
            </p>
          </div>

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                size="sm"
                disabled={buying}
                className="bg-[#FF5800] hover:bg-[#e54f00] text-white rounded-sm shrink-0"
              >
                {buying ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ShoppingCart className="h-4 w-4" />
                )}
                <span className="ml-1.5">
                  {t("cloud.appDomains.buyAction", {
                    defaultValue: "Buy {{price}}",
                    price: formatUsd(result.price.totalUsdCents),
                  })}
                </span>
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>
                  {t("cloud.appDomains.buyConfirmTitle", {
                    defaultValue: "Buy {{domain}}?",
                    domain: result.domain,
                  })}
                </AlertDialogTitle>
                <AlertDialogDescription>
                  {t("cloud.appDomains.buyConfirmBody", {
                    defaultValue:
                      "{{price}} will be charged from your credit balance now. The domain renews automatically each year at {{renewal}} unless you cancel.",
                    price: formatUsd(result.price.totalUsdCents),
                    renewal: formatUsd(
                      (result.renewal ?? result.price).totalUsdCents,
                    ),
                  })}
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>
                  {t("common.cancel", { defaultValue: "Cancel" })}
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => void handleBuy()}
                  className="bg-[#FF5800] hover:bg-[#e54f00] text-white"
                >
                  {t("cloud.appDomains.buyConfirmAction", {
                    defaultValue: "Buy domain",
                  })}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      )}

      {error && (
        <div className="flex flex-col gap-2 p-3 rounded-sm bg-red-500/10 border border-red-500/20">
          <div className="flex items-center gap-2 text-sm text-red-300">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{error}</span>
          </div>
          {needsCredits && (
            <Button
              size="sm"
              variant="outline"
              onClick={openBilling}
              className="self-start border-neutral-700 hover:bg-white/5"
            >
              <CreditCard className="h-4 w-4 mr-1.5" />
              {t("cloud.appDomains.buyAddCredits", {
                defaultValue: "Add credits",
              })}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
