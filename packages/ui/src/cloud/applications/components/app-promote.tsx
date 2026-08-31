/**
 * Application detail — Promote tab.
 *
 * Renders the live promotion surfaces wired to the typed `api` client:
 * promotion-suggestions (GET), connected ad accounts (GET), asset generation
 * (POST, then re-fetch), and the shared `PromoteAppDialog` from cloud-ui.
 */

import { ExternalLink, Loader2, Megaphone, Plus, Sparkles } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { PromoteAppDialog } from "../../../cloud-ui/components/promotion/promote-app-dialog";
import { Badge } from "../../../components/ui/badge";
import { Button } from "../../../components/ui/button";
import { Card } from "../../../components/ui/card";
import { ApiError, api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { App } from "../lib/apps";
import { openCloudConsoleRouteExternally } from "../lib/native-cloud-nav";

interface AppPromoteProps {
  app: App;
}

interface PromotionSuggestions {
  recommendedChannels: string[];
  estimatedBudget: { min: number; max: number };
  suggestedPlatforms: string[];
  tips: string[];
}

interface AdAccount {
  id: string;
  platform: string;
  accountName: string;
}

export function AppPromote({ app }: AppPromoteProps) {
  const t = useCloudT();
  const [showPromoteDialog, setShowPromoteDialog] = useState(false);
  const [suggestions, setSuggestions] = useState<PromotionSuggestions | null>(
    null,
  );
  const [adAccounts, setAdAccounts] = useState<AdAccount[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isGeneratingAssets, setIsGeneratingAssets] = useState(false);
  const [assetError, setAssetError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [suggestionsResult, accountsResult] = await Promise.allSettled([
        api<PromotionSuggestions>(`/api/v1/apps/${app.id}/promote`),
        api<{ accounts?: AdAccount[] }>("/api/v1/advertising/accounts"),
      ]);
      if (suggestionsResult.status === "fulfilled") {
        setSuggestions(suggestionsResult.value);
      }
      if (accountsResult.status === "fulfilled") {
        setAdAccounts(accountsResult.value.accounts || []);
      }
    } finally {
      setIsLoading(false);
    }
  }, [app.id]);

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const handleGenerateAssets = async () => {
    setIsGeneratingAssets(true);
    setAssetError(null);
    try {
      await api(`/api/v1/apps/${app.id}/promote/assets`, {
        method: "POST",
        json: { includeCopy: true, includeAdBanners: true },
      });
      await fetchData();
    } catch (err) {
      // The backend treats this as critical enough to refund credits on
      // failure (e.g. 402 Insufficient Credits / 500), so surface the error
      // instead of silently clearing the spinner and implying success.
      setAssetError(
        err instanceof ApiError || err instanceof Error
          ? err.message
          : t("cloud.appPromote.generateError", {
              defaultValue: "Asset generation failed. Please try again.",
            }),
      );
    } finally {
      setIsGeneratingAssets(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="size-8 animate-spin text-neutral-400" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-sm font-medium text-txt flex items-center gap-2">
            <Megaphone className="size-4 text-muted" />
            {t("cloud.appPromote.title", {
              name: app.name,
              defaultValue: "Promote {{name}}",
            })}
          </h3>
          <p className="text-xs text-neutral-500 mt-1">
            {t("cloud.appPromote.subtitle", {
              defaultValue:
                "Reach more users through social media, SEO, and advertising",
            })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerateAssets}
            disabled={isGeneratingAssets}
          >
            {isGeneratingAssets ? (
              <>
                <Loader2 className="size-4 mr-1.5 animate-spin" />
                {t("cloud.appPromote.generating", {
                  defaultValue: "Generating...",
                })}
              </>
            ) : (
              <>
                <Sparkles className="size-4 mr-1.5" />
                {t("cloud.appPromote.generateAssets", {
                  defaultValue: "Generate Assets",
                })}
              </>
            )}
          </Button>
          <Button onClick={() => setShowPromoteDialog(true)} size="sm">
            <Megaphone className="size-4 mr-1.5" />
            {t("cloud.appPromote.launch", { defaultValue: "Launch Promotion" })}
          </Button>
        </div>
      </div>
      {assetError && (
        <p className="text-sm text-destructive" role="alert">
          {assetError}
        </p>
      )}

      {/* Suggestions */}
      {suggestions && (
        <Card stack="default" variant="flatPadded">
          <h3 className="text-sm font-medium text-txt">
            {t("cloud.appPromote.tipsTitle", {
              defaultValue: "Promotion Tips",
            })}
          </h3>
          <div className="space-y-2">
            {suggestions.tips.map((tip, index) => (
              <div key={tip} className="flex items-start gap-2">
                <div className="size-5 rounded-full bg-muted flex items-center justify-center shrink-0 mt-0.5">
                  <span className="text-txt text-2xs font-semibold">
                    {index + 1}
                  </span>
                </div>
                <p className="text-xs text-neutral-300">{tip}</p>
              </div>
            ))}
          </div>

          <div className="pt-3 border-t border-border">
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">
                {t("cloud.appPromote.estimatedBudget", {
                  defaultValue: "Estimated budget range:",
                })}
              </span>
              <span className="text-txt font-medium">
                ${suggestions.estimatedBudget.min} - $
                {suggestions.estimatedBudget.max}
              </span>
            </div>
          </div>
        </Card>
      )}

      {/* Connected Ad Accounts */}
      <Card stack="default" variant="flatPadded">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-medium text-txt">
            {t("cloud.appPromote.connectedAccounts", {
              defaultValue: "Connected Ad Accounts",
            })}
          </h3>
          <Button variant="outline" size="sm" asChild>
            <Link
              to="/cloud/connectors"
              onClick={(e) => {
                // Native studio: the connections surface lives outside the
                // apps-only MemoryRouter — open it in the system browser. No-op
                // on web (the in-router navigation runs unchanged).
                if (openCloudConsoleRouteExternally("/cloud/connectors")) {
                  e.preventDefault();
                }
              }}
            >
              <Plus className="size-4 mr-1.5" />
              {t("cloud.appPromote.connect", { defaultValue: "Connect" })}
            </Link>
          </Button>
        </div>

        {adAccounts.length === 0 ? (
          <div className="text-center py-6 text-neutral-500">
            <Megaphone className="size-10 mx-auto mb-2 opacity-40" />
            <p className="text-xs">
              {t("cloud.appPromote.noAccounts", {
                defaultValue: "No ad accounts connected",
              })}
            </p>
            <p className="text-xs text-neutral-600">
              {t("cloud.appPromote.connectHint", {
                defaultValue: "Connect a Meta, Google, or TikTok ads account",
              })}
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {adAccounts.map((account) => (
              <Card key={account.id} flow="rowBetween" variant="insetPadded">
                <div className="flex items-center gap-2">
                  <Badge variant="outline">{account.platform}</Badge>
                  <span className="text-sm text-txt">
                    {account.accountName}
                  </span>
                </div>
                <Button variant="ghost" size="icon-sm">
                  <ExternalLink className="size-4" />
                </Button>
              </Card>
            ))}
          </div>
        )}
      </Card>

      {/* Promote Dialog */}
      <PromoteAppDialog
        open={showPromoteDialog}
        onOpenChange={setShowPromoteDialog}
        app={{
          id: app.id,
          name: app.name,
          description: app.description ?? undefined,
          app_url: app.app_url,
        }}
        adAccounts={adAccounts}
      />
    </div>
  );
}
