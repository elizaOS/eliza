/**
 * Application detail — Monetization tab.
 * GET/PUT `/api/v1/apps/:id/monetization` go through the typed `api` client.
 * Reuses the shared `EarningsSimulator` + `RevenueFlowDiagram` from cloud-ui.
 */

import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronRight,
  Coins,
  DollarSign,
  Info,
  Loader2,
  Save,
  Send,
  Server,
  ShieldCheck,
} from "lucide-react";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  EarningsSimulator,
  RevenueFlowDiagram,
} from "../../../cloud-ui/components/monetization";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Slider } from "../../../components/ui/slider";
import { Switch } from "../../../components/ui/switch";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../../components/ui/tooltip";
import { cn } from "../../../lib/utils";
import { ApiError, api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import type { App } from "../lib/apps";
import { appQueryKey } from "../lib/apps";
import { openCloudConsoleRouteExternally } from "../lib/native-cloud-nav";

interface MonetizationSettings {
  monetizationEnabled: boolean;
  inferenceMarkupPercentage: number;
  purchaseSharePercentage: number;
  platformOffsetAmount: number;
  totalCreatorEarnings: number;
}

interface MonetizationResponse {
  success?: boolean;
  monetization?: MonetizationSettings;
  error?: string;
  review_status?: App["review_status"];
}

interface ReviewSubmissionResponse {
  success?: boolean;
  review?: {
    review_status: App["review_status"];
    rationale?: string | null;
  };
  error?: string;
}

interface AppMonetizationSettingsProps {
  app: App;
}

export function AppMonetizationSettings({ app }: AppMonetizationSettingsProps) {
  const t = useCloudT();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const appId = app.id;
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isSubmittingReview, setIsSubmittingReview] = useState(false);
  const [reviewStatus, setReviewStatus] = useState<App["review_status"]>(
    app.review_status,
  );
  const [reviewRationale, setReviewRationale] = useState<string | null>(null);
  const [settings, setSettings] = useState<MonetizationSettings>({
    monetizationEnabled: false,
    inferenceMarkupPercentage: 0,
    purchaseSharePercentage: 10,
    platformOffsetAmount: 1,
    totalCreatorEarnings: 0,
  });
  const [hasChanges, setHasChanges] = useState(false);
  const [showEnableDialog, setShowEnableDialog] = useState(false);
  // The last monetization-enabled state the server confirmed. Only an ENABLE
  // transition (server-disabled → enabled) is review-gated; disabling and
  // editing an already-enabled row are always allowed.
  const [serverMonetizationEnabled, setServerMonetizationEnabled] =
    useState(false);

  useEffect(() => {
    setReviewStatus(app.review_status);
  }, [app.review_status]);

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void api<MonetizationResponse>(`/api/v1/apps/${appId}/monetization`)
      .then((data) => {
        if (cancelled) return;
        if (data.success && data.monetization) {
          setSettings(data.monetization);
          setServerMonetizationEnabled(data.monetization.monetizationEnabled);
        }
      })
      .catch((error) => {
        if (cancelled) return;
        toast.error(
          error instanceof Error
            ? error.message
            : t("cloud.monetization.loadFailed", {
                defaultValue: "Failed to load settings",
              }),
        );
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [appId, t]);

  const handleSave = async () => {
    // Only the ENABLE transition is review-gated. Saving markup/share edits on
    // an already-enabled row, or disabling, must never be blocked here — the
    // server is the source of truth and re-enforces (returning review_status in
    // a 403 body the UI parses).
    const isEnableTransition =
      settings.monetizationEnabled && !serverMonetizationEnabled;
    if (isEnableTransition && reviewStatus !== "approved") {
      toast.error(
        t("cloud.monetization.reviewRequiredSave", {
          defaultValue:
            "Submit this app for review before enabling monetization.",
        }),
      );
      return;
    }

    setIsSaving(true);
    try {
      await api(`/api/v1/apps/${appId}/monetization`, {
        method: "PUT",
        json: {
          monetizationEnabled: settings.monetizationEnabled,
          inferenceMarkupPercentage: settings.inferenceMarkupPercentage,
          purchaseSharePercentage: settings.purchaseSharePercentage,
        },
      });
      setServerMonetizationEnabled(settings.monetizationEnabled);
      toast.success(
        t("cloud.monetization.saved", { defaultValue: "Settings saved" }),
      );
      setHasChanges(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : t("cloud.monetization.saveFailed", {
              defaultValue: "Failed to save settings",
            }),
      );
    } finally {
      setIsSaving(false);
    }
  };

  const updateSetting = <K extends keyof MonetizationSettings>(
    key: K,
    value: MonetizationSettings[K],
  ) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setHasChanges(true);
  };

  const toggleMonetization = async (enabled: boolean) => {
    if (enabled && reviewStatus !== "approved") {
      toast.error(
        t("cloud.monetization.reviewRequiredToggle", {
          defaultValue:
            "Submit this app for review before enabling monetization.",
        }),
      );
      return;
    }

    setSettings((prev) => ({ ...prev, monetizationEnabled: enabled }));
    try {
      const data = await api<MonetizationResponse>(
        `/api/v1/apps/${appId}/monetization`,
        {
          method: "PUT",
          json: {
            monetizationEnabled: enabled,
            inferenceMarkupPercentage: settings.inferenceMarkupPercentage,
            purchaseSharePercentage: settings.purchaseSharePercentage,
          },
        },
      );
      if (data.review_status) setReviewStatus(data.review_status);
      setServerMonetizationEnabled(enabled);
      toast.success(
        enabled
          ? t("cloud.monetization.enabled", {
              defaultValue: "Monetization enabled",
            })
          : t("cloud.monetization.disabled", {
              defaultValue: "Monetization disabled",
            }),
      );
    } catch (error) {
      // Revert on failure
      setSettings((prev) => ({ ...prev, monetizationEnabled: !enabled }));
      if (error instanceof ApiError && isReviewStatusErrorBody(error.body)) {
        setReviewStatus(error.body.review_status);
      }
      toast.error(
        error instanceof Error
          ? error.message
          : t("cloud.monetization.updateFailed", {
              defaultValue: "Failed to update monetization",
            }),
      );
    }
  };

  const submitForReview = async () => {
    setIsSubmittingReview(true);
    setReviewStatus("submitted");
    setReviewRationale(null);
    try {
      const data = await api<ReviewSubmissionResponse>(
        `/api/v1/apps/${appId}/review`,
        { method: "POST" },
      );
      const nextStatus = data.review?.review_status ?? "under_review";
      setReviewStatus(nextStatus);
      setReviewRationale(data.review?.rationale ?? null);
      await queryClient.invalidateQueries({ queryKey: appQueryKey(appId) });
      toast.success(
        nextStatus === "approved"
          ? t("cloud.monetization.reviewApproved", {
              defaultValue: "Review approved. You can enable monetization.",
            })
          : t("cloud.monetization.reviewSubmitted", {
              defaultValue: "Review submitted.",
            }),
      );
    } catch (error) {
      setReviewStatus(app.review_status);
      toast.error(
        error instanceof Error
          ? error.message
          : t("cloud.monetization.reviewSubmitFailed", {
              defaultValue: "Failed to submit review",
            }),
      );
    } finally {
      setIsSubmittingReview(false);
    }
  };

  const reviewApproved = reviewStatus === "approved";
  const canSubmitReview =
    reviewStatus === "draft" || reviewStatus === "rejected";

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-[var(--brand-orange)]" />
      </div>
    );
  }

  return (
    <TooltipProvider>
      <div className="space-y-4">
        <div className="border border-border bg-card p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-start gap-3">
              <div
                className={cn(
                  "mt-0.5 rounded-sm p-2",
                  reviewApproved ? "bg-green-500/10" : "bg-surface",
                )}
              >
                <ShieldCheck
                  className={cn(
                    "h-5 w-5",
                    reviewApproved ? "text-green-400" : "text-muted",
                  )}
                />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-medium text-txt">
                  {getReviewStatusLabel(reviewStatus, t)}
                </p>
                <p className="mt-1 text-xs text-neutral-500">
                  {reviewApproved
                    ? t("cloud.monetization.reviewApprovedDesc", {
                        defaultValue:
                          "This app passed review and can earn from paid usage.",
                      })
                    : t("cloud.monetization.reviewRequiredDesc", {
                        defaultValue:
                          "Apps must pass automated review before monetization can be enabled.",
                      })}
                </p>
                {reviewRationale && (
                  <p className="mt-2 text-xs text-neutral-400">
                    {reviewRationale}
                  </p>
                )}
              </div>
            </div>
            {canSubmitReview && (
              <Button
                type="button"
                onClick={submitForReview}
                disabled={isSubmittingReview}
                className="shrink-0 bg-[var(--brand-orange)] text-txt hover:bg-[#e54f00]"
              >
                {isSubmittingReview ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Send className="mr-2 h-4 w-4" />
                )}
                {t("cloud.monetization.submitReview", {
                  defaultValue: "Submit for review",
                })}
              </Button>
            )}
          </div>
        </div>

        {/* Monetization Toggle Card */}
        <div
          className={cn(
            "rounded-sm p-4 border transition-colors",
            settings.monetizationEnabled
              ? "bg-green-500/5 border-green-500/20"
              : "bg-card border-border",
          )}
        >
          <div className="flex items-start gap-3">
            <div
              className={cn(
                "p-2 rounded-sm mt-0.5",
                settings.monetizationEnabled ? "bg-green-500/10" : "bg-surface",
              )}
            >
              <DollarSign
                className={cn(
                  "h-5 w-5",
                  settings.monetizationEnabled
                    ? "text-green-400"
                    : "text-muted",
                )}
              />
            </div>
            <div className="flex-1">
              <div className="flex items-center justify-between">
                <p className="text-sm font-medium text-txt">
                  {settings.monetizationEnabled
                    ? t("cloud.monetization.active", {
                        defaultValue: "Monetization Active",
                      })
                    : t("cloud.monetization.enableTitle", {
                        defaultValue: "Enable Monetization",
                      })}
                </p>
                <Switch
                  // The server always allows DISABLING; only ENABLING is
                  // review-gated. So the switch must stay interactive for a
                  // legacy enabled-but-unapproved row — otherwise it's trapped
                  // ON with no way to turn it off.
                  checked={settings.monetizationEnabled}
                  disabled={!reviewApproved && !settings.monetizationEnabled}
                  onCheckedChange={(checked) => {
                    if (checked && !settings.monetizationEnabled) {
                      setShowEnableDialog(true);
                    } else {
                      toggleMonetization(checked);
                    }
                  }}
                  className="data-[state=checked]:bg-green-500 data-[state=unchecked]:bg-neutral-700"
                />
              </div>
              <p className="text-xs text-neutral-500 mt-1">
                {settings.monetizationEnabled
                  ? t("cloud.monetization.activeDesc", {
                      defaultValue:
                        "Earning from inference markups and credit purchases. Users pay app-specific credits.",
                    })
                  : t("cloud.monetization.enableDesc", {
                      defaultValue:
                        "Start earning from your app. You'll earn from inference markups and credit purchases.",
                    })}
              </p>
              {settings.totalCreatorEarnings > 0 && (
                <Button
                  variant="ghost"
                  type="button"
                  onClick={() =>
                    navigate(`/dashboard/apps/${appId}?tab=earnings`)
                  }
                  className="mt-2 text-xs text-muted hover:text-txt transition-colors flex items-center gap-1"
                >
                  {t("cloud.monetization.earned", {
                    amount: settings.totalCreatorEarnings.toFixed(2),
                    defaultValue: "$" + "{{amount}}" + " earned",
                  })}
                  <ChevronRight className="h-3 w-3" />
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Settings Grid */}
        <div className="grid gap-4 lg:grid-cols-2">
          {/* Markup Controls */}
          <div className="bg-card rounded-sm p-4 space-y-4">
            <h3 className="text-sm font-medium text-txt">
              {t("cloud.monetization.revenueSettings", {
                defaultValue: "Revenue Settings",
              })}
            </h3>

            {/* Inference Markup */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-txt">
                    {t("cloud.monetization.inferenceMarkup", {
                      defaultValue: "Inference Markup",
                    })}
                  </span>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3.5 w-3.5 text-neutral-500" />
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="max-w-[200px] bg-card border-border text-txt"
                    >
                      {t("cloud.monetization.inferenceMarkupTooltip", {
                        defaultValue:
                          "Markup on LLM costs. Higher = more per request.",
                      })}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-lg font-mono font-semibold text-purple-400">
                  {settings.inferenceMarkupPercentage}%
                </span>
              </div>
              <Slider
                value={[settings.inferenceMarkupPercentage]}
                onValueChange={([value]) =>
                  updateSetting("inferenceMarkupPercentage", value)
                }
                min={0}
                max={500}
                step={5}
                className="w-full"
              />
              <div className="flex gap-1.5 flex-wrap">
                {[0, 25, 50, 100, 200].map((preset) => (
                  <Button
                    variant="ghost"
                    type="button"
                    key={preset}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-sm transition-colors",
                      settings.inferenceMarkupPercentage === preset
                        ? "bg-purple-500/20 text-purple-400 border border-purple-500/30"
                        : "bg-surface text-neutral-400 hover:bg-bg-hover border border-transparent",
                    )}
                    onClick={() =>
                      updateSetting("inferenceMarkupPercentage", preset)
                    }
                  >
                    {preset}%
                  </Button>
                ))}
              </div>
            </div>

            <div className="h-px bg-surface" />

            {/* Purchase Share */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-txt">
                    {t("cloud.monetization.purchaseShare", {
                      defaultValue: "Purchase Share",
                    })}
                  </span>
                  <Tooltip>
                    <TooltipTrigger>
                      <Info className="h-3.5 w-3.5 text-neutral-500" />
                    </TooltipTrigger>
                    <TooltipContent
                      side="right"
                      className="max-w-[200px] bg-card border-border text-txt"
                    >
                      {t("cloud.monetization.purchaseShareTooltip", {
                        defaultValue:
                          "Your cut of credit purchases after platform fee.",
                      })}
                    </TooltipContent>
                  </Tooltip>
                </div>
                <span className="text-lg font-mono font-semibold text-orange-400">
                  {settings.purchaseSharePercentage}%
                </span>
              </div>
              <Slider
                value={[settings.purchaseSharePercentage]}
                onValueChange={([value]) =>
                  updateSetting("purchaseSharePercentage", value)
                }
                min={0}
                max={50}
                step={5}
                className="w-full"
              />
              <div className="flex gap-1.5 flex-wrap">
                {[0, 10, 20, 30, 50].map((preset) => (
                  <Button
                    variant="ghost"
                    type="button"
                    key={preset}
                    className={cn(
                      "px-2.5 py-1 text-xs rounded-sm transition-colors",
                      settings.purchaseSharePercentage === preset
                        ? "bg-orange-500/20 text-txt border border-orange-500/30"
                        : "bg-surface text-neutral-400 hover:bg-bg-hover border border-transparent",
                    )}
                    onClick={() =>
                      updateSetting("purchaseSharePercentage", preset)
                    }
                  >
                    {preset}%
                  </Button>
                ))}
              </div>
            </div>

            {/* Save Button */}
            <div className="pt-2">
              <Button
                onClick={handleSave}
                disabled={!hasChanges || isSaving}
                className="w-full bg-[var(--brand-orange)] hover:bg-[#e54f00] text-white disabled:bg-surface disabled:text-muted"
              >
                {isSaving ? (
                  <Loader2 className="h-4 w-4 animate-spin mr-2" />
                ) : (
                  <Save className="h-4 w-4 mr-2" />
                )}
                {t("cloud.monetization.saveChanges", {
                  defaultValue: "Save Changes",
                })}
              </Button>
            </div>
          </div>

          {/* Revenue Flow Diagram */}
          <RevenueFlowDiagram
            markupPercentage={settings.inferenceMarkupPercentage}
            purchaseSharePercentage={settings.purchaseSharePercentage}
          />
        </div>

        {/* Earnings Simulator */}
        <EarningsSimulator
          markupPercentage={settings.inferenceMarkupPercentage}
          purchaseSharePercentage={settings.purchaseSharePercentage}
        />

        {/* Self-Host CTA — closes the loop: app earns → fund refills → container stays alive */}
        {settings.monetizationEnabled && <SelfHostCTA />}

        {/* Enable Monetization Confirmation Dialog */}
        <AlertDialog open={showEnableDialog} onOpenChange={setShowEnableDialog}>
          <AlertDialogContent className="bg-card border-border">
            <AlertDialogHeader>
              <AlertDialogTitle className="text-txt text-center sm:text-left">
                {t("cloud.monetization.enableDialogTitle", {
                  defaultValue: "Enable Monetization?",
                })}
              </AlertDialogTitle>
              <AlertDialogDescription className="text-neutral-400 space-y-3 text-left">
                {t("cloud.monetization.enableDialogIntro", {
                  defaultValue:
                    "When monetization is enabled, users of your app will:",
                })}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <div className="text-neutral-400 space-y-3 text-left text-sm">
              <ul className="list-disc list-inside space-y-1">
                <li>
                  {t("cloud.monetization.enableDialogPoint1", {
                    defaultValue: "Pay app-specific credits (separate balance)",
                  })}
                </li>
                <li>
                  {t("cloud.monetization.enableDialogPoint2", {
                    defaultValue:
                      "See inference costs with your markup applied",
                  })}
                </li>
                <li>
                  {t("cloud.monetization.enableDialogPoint3", {
                    defaultValue:
                      "Purchase credits that contribute to your earnings",
                  })}
                </li>
              </ul>
              <p className="pt-2 text-[var(--brand-orange)]">
                {t("cloud.monetization.enableDialogNote", {
                  defaultValue:
                    "You can adjust markup and purchase share after enabling.",
                })}
              </p>
            </div>
            <AlertDialogFooter className="gap-2 sm:gap-2">
              <AlertDialogCancel className="border-0 bg-transparent text-neutral-400 hover:text-txt hover:bg-transparent">
                {t("cloud.monetization.cancel", { defaultValue: "Cancel" })}
              </AlertDialogCancel>
              <AlertDialogAction
                onClick={() => {
                  toggleMonetization(true);
                  setShowEnableDialog(false);
                }}
                className="bg-[var(--brand-orange)] hover:bg-[#e54f00] text-txt px-6"
              >
                {t("cloud.monetization.startEarning", {
                  defaultValue: "Start Earning",
                })}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </TooltipProvider>
  );
}

function isReviewStatusErrorBody(
  body: unknown,
): body is { review_status: App["review_status"] } {
  return (
    typeof body === "object" &&
    body !== null &&
    "review_status" in body &&
    typeof (body as { review_status?: unknown }).review_status === "string"
  );
}

function getReviewStatusLabel(
  status: App["review_status"],
  t: ReturnType<typeof useCloudT>,
): string {
  switch (status) {
    case "approved":
      return t("cloud.monetization.reviewStatusApproved", {
        defaultValue: "Review approved",
      });
    case "submitted":
      return t("cloud.monetization.reviewStatusSubmitted", {
        defaultValue: "Review submitted",
      });
    case "under_review":
      return t("cloud.monetization.reviewStatusInProgress", {
        defaultValue: "Review in progress",
      });
    case "rejected":
      return t("cloud.monetization.reviewStatusRejected", {
        defaultValue: "Review rejected",
      });
    default:
      return t("cloud.monetization.reviewStatusRequired", {
        defaultValue: "Review required",
      });
  }
}

/**
 * Self-hosting CTA shown only when monetization is on. Tells the loop story:
 * deploy the app as its own container — earnings pay the daily hosting bill
 * automatically. Cashout still works any time via the Earnings page.
 */
function SelfHostCTA() {
  const t = useCloudT();
  return (
    <div className="border border-[var(--brand-orange)]/30 bg-[var(--brand-orange)]/10 p-5">
      <div className="flex items-start gap-4">
        <div className="hidden sm:flex items-center justify-center w-10 h-10 rounded-sm border border-[var(--brand-orange)]/40 bg-[var(--brand-orange)]/10 shrink-0">
          <Server className="h-5 w-5 text-[var(--brand-orange)]" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-mono text-txt mb-1">
            {t("cloud.monetization.selfHostTitle", {
              defaultValue: "Let this app host itself.",
            })}
          </h3>
          <p className="text-sm text-muted mb-3">
            {t("cloud.monetization.selfHostDesc", {
              defaultValue:
                "Deploy as a container — daily hosting bills are paid from your app earnings first, then your credits. No setup, no settings. Cashout still works whenever you want.",
            })}
          </p>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/dashboard/agents"
              onClick={(e) => {
                // Native studio: the agents surface is outside the apps-only
                // MemoryRouter — open it in the system browser. No-op on web.
                if (openCloudConsoleRouteExternally("/dashboard/agents")) {
                  e.preventDefault();
                }
              }}
              className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--brand-orange)] hover:bg-[#e54f00] text-txt text-sm font-mono transition-colors"
            >
              <Server className="h-4 w-4" />
              {t("cloud.monetization.deployAgent", {
                defaultValue: "Deploy an Agent",
              })}
            </Link>
            <Link
              to="/dashboard/earnings"
              onClick={(e) => {
                // Native studio: the org earnings surface is outside the
                // apps-only MemoryRouter — open it in the system browser.
                if (openCloudConsoleRouteExternally("/dashboard/earnings")) {
                  e.preventDefault();
                }
              }}
              className="inline-flex items-center gap-2 px-4 py-2 text-muted hover:bg-foreground hover:text-background text-sm font-mono transition-colors"
            >
              <Coins className="h-4 w-4" />
              {t("cloud.monetization.viewEarnings", {
                defaultValue: "View Earnings",
              })}
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
