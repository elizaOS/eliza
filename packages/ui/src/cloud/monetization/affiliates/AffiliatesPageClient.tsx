/**
 * Affiliates & Referrals client.
 *
 * Data: GET `/api/v1/affiliates` (auto-create on first load via POST), POST/PUT
 * `/api/v1/affiliates` (markup), GET `/api/v1/referrals` (via
 * {@link useDashboardReferralMe}).
 */

"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Link as LinkIcon,
  UserCog,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { BrandCard, Button, Input, Skeleton } from "../../../cloud-ui";
import { ApiError, api } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  buildReferralInviteLoginUrl,
  copyTextToClipboard,
  useCopyFeedback,
} from "../lib/clipboard";
import { useDashboardReferralMe } from "./use-dashboard-referral-me";

interface AffiliateData {
  id: string;
  code: string;
  markup_percent: string;
  is_active: boolean;
}

interface AffiliateResponse {
  code?: AffiliateData;
}

/**
 * Canonical app origin fallback for SSR (no `window`). In the browser
 * `window.location.origin` always wins. Ported from cloud-shared `getAppUrl`,
 * trimmed to the browser/SSR fallback the affiliates page actually uses.
 */
function getAppUrl(): string {
  const configured =
    typeof process !== "undefined" &&
    typeof process.env?.NEXT_PUBLIC_APP_URL === "string"
      ? process.env.NEXT_PUBLIC_APP_URL
      : undefined;
  const url = configured || "http://localhost:3000";
  const base = url.startsWith("http") ? url : `https://${url}`;
  return base.replace(/\/$/, "");
}

export function AffiliatesPageClient() {
  const t = useCloudT();
  const [affiliateData, setAffiliateData] = useState<AffiliateData | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const [markupPercent, setMarkupPercent] = useState<string>("20.00");
  const [isSaving, setIsSaving] = useState(false);
  const { copied, markCopied: markAffiliateCopied } = useCopyFeedback();
  const { copied: referralCopied, markCopied: markReferralCopied } =
    useCopyFeedback();
  const {
    referralMe,
    loadingReferral,
    referralFetchFailed,
    refetch: refetchReferral,
  } = useDashboardReferralMe();

  const createAffiliateCode = useCallback(async (initialMarkup = 20) => {
    const data = await api<AffiliateResponse>("/api/v1/affiliates", {
      method: "POST",
      json: { markupPercent: initialMarkup },
    });
    if (data.code) {
      setAffiliateData(data.code);
      setMarkupPercent(data.code.markup_percent);
    }
    return data.code;
  }, []);

  const fetchAffiliateData = useCallback(async () => {
    try {
      const data = await api<AffiliateResponse>("/api/v1/affiliates");
      if (data.code) {
        setAffiliateData(data.code);
        setMarkupPercent(data.code.markup_percent);
      } else {
        await createAffiliateCode();
      }
    } catch (_e) {
      toast.error(
        t("cloud.affiliates.failedToLoad", {
          defaultValue: "Failed to load affiliate data",
        }),
      );
    } finally {
      setLoading(false);
    }
  }, [createAffiliateCode, t]);

  useEffect(() => {
    fetchAffiliateData();
  }, [fetchAffiliateData]);

  const handleCopyLink = async () => {
    if (!affiliateData) return;
    const url = `${window.location.origin}/login?affiliate=${affiliateData.code}`;
    const ok = await copyTextToClipboard(url);
    if (ok) {
      markAffiliateCopied();
      toast.success(
        t("cloud.affiliates.linkCopied", {
          defaultValue: "Link copied to clipboard!",
        }),
      );
    } else {
      toast.error(
        t("cloud.affiliates.couldNotCopy", {
          defaultValue: "Could not copy to clipboard",
        }),
      );
    }
  };

  const handleSaveMarkup = async () => {
    const numericValue = parseFloat(markupPercent);
    if (Number.isNaN(numericValue) || numericValue < 0 || numericValue > 1000) {
      toast.error(
        t("cloud.affiliates.invalidMarkup", {
          defaultValue: "Invalid markup. Must be between 0 and 1000%.",
        }),
      );
      return;
    }

    setIsSaving(true);
    try {
      const data = await api<AffiliateResponse>("/api/v1/affiliates", {
        method: affiliateData ? "PUT" : "POST",
        json: { markupPercent: numericValue },
      });
      if (data.code) {
        setAffiliateData(data.code);
        setMarkupPercent(data.code.markup_percent);
      }
      toast.success(
        t("cloud.affiliates.markupUpdated", {
          defaultValue: "Markup percentage updated!",
        }),
      );
    } catch (e) {
      const message =
        e instanceof ApiError
          ? e.message
          : t("cloud.affiliates.unexpectedError", {
              defaultValue: "An unexpected error occurred",
            });
      toast.error(message);
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-4xl mx-auto">
        <Skeleton className="h-44 rounded-sm" />
        <Skeleton className="h-36 rounded-sm" />
        <Skeleton className="h-44 rounded-sm" />
      </div>
    );
  }

  const pageOrigin =
    typeof window !== "undefined" ? window.location.origin : getAppUrl();

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto">
      {/* Introduction Banner */}
      <BrandCard className="relative" corners={false}>
        <div className="flex items-start gap-3">
          <UserCog className="h-5 w-5 text-accent mt-0.5 shrink-0" />
          <div>
            <h3 className="text-xl font-semibold text-txt-strong mb-2">
              {t("cloud.affiliates.programTitle", {
                defaultValue: "Affiliate Program",
              })}
            </h3>
            <p className="text-sm text-muted mb-2">
              {t("cloud.affiliates.programIntro", {
                defaultValue:
                  "Share your customized affiliate link with your users and partners to earn a percentage of their marked-up top-ups and MCP usage.",
              })}
            </p>
            <p className="text-sm text-muted">
              {t("cloud.affiliates.programDetailPre", {
                defaultValue:
                  "When a user signs up using your link, you get a direct cut (your markup percentage) of their activity forever. You can track this revenue in your",
              })}
              <Link
                to="/dashboard/earnings"
                className="text-accent hover:underline mx-1"
              >
                {t("cloud.affiliates.earnings", {
                  defaultValue: "Earnings",
                })}
              </Link>
              {t("cloud.affiliates.programDetailPost", {
                defaultValue:
                  "dashboard, which can be withdrawn to any EVM or Solana wallet as $ELIZA tokens.",
              })}
            </p>
          </div>
        </div>
      </BrandCard>

      {/* Referral invite: uses GET /api/v1/referrals (parallel to affiliate
          fetch, own loading state). Different URL (?ref= vs ?affiliate=),
          economics, and copy from the affiliate card below. */}
      <BrandCard
        corners={false}
        className="border-l-4 border-l-accent border border-border"
      >
        <div className="flex items-start gap-3 mb-4">
          <Users className="h-5 w-5 text-accent mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-txt-strong mb-1">
              {t("cloud.affiliates.inviteFriends", {
                defaultValue: "Invite friends",
              })}
            </h3>
            <p className="text-sm text-muted">
              {t("cloud.affiliates.inviteFriendsDesc", {
                defaultValue:
                  "Share your invite link—you both earn bonus credits when they sign up, and you earn a share of their purchases on Eliza Cloud.",
              })}
            </p>
          </div>
        </div>

        {loadingReferral ? (
          <Skeleton className="h-14 rounded-sm" />
        ) : referralFetchFailed || !referralMe ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-muted">
              {t("cloud.affiliates.couldNotLoadInvite", {
                defaultValue: "Could not load your invite link.",
              })}
            </p>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0"
              onClick={() => refetchReferral()}
            >
              {t("cloud.affiliates.retry", { defaultValue: "Retry" })}
            </Button>
          </div>
        ) : !referralMe.is_active ? (
          <div className="rounded-sm border border-status-warning/30 bg-status-warning-bg p-3 text-sm text-status-warning">
            <p className="font-medium text-status-warning">
              {t("cloud.affiliates.inviteInactive", {
                defaultValue: "Invite link inactive",
              })}
            </p>
            <p className="mt-1 text-status-warning">
              {t("cloud.affiliates.inviteInactiveDesc", {
                defaultValue:
                  "Your referral code is turned off for new signups. Only an Eliza Cloud administrator can re-enable it. If you believe this is a mistake,",
              })}{" "}
              <a
                href="mailto:support@eliza.cloud?subject=Referral%20code%20inactive"
                className="text-txt-strong underline hover:opacity-75"
              >
                {t("cloud.affiliates.emailSupport", {
                  defaultValue: "email support@eliza.cloud",
                })}
              </a>
              .
            </p>
            <p className="mt-2 font-mono text-xs text-muted break-all">
              {buildReferralInviteLoginUrl(pageOrigin, referralMe.code)}
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-muted mb-3">
              {referralMe.total_referrals === 0
                ? t("cloud.affiliates.noFriendsJoined", {
                    defaultValue:
                      "No friends have joined yet—share your link to get started.",
                  })
                : referralMe.total_referrals === 1
                  ? t("cloud.affiliates.oneFriendJoined", {
                      defaultValue: "1 friend has joined with your link.",
                    })
                  : t("cloud.affiliates.friendsJoined", {
                      count: referralMe.total_referrals,
                      defaultValue:
                        "{{count}} friends have joined with your link.",
                    })}
            </p>
            <div className="flex items-center gap-3 bg-bg-hover border border-accent/20 rounded-sm p-3">
              <LinkIcon className="h-5 w-5 text-accent/60 shrink-0" />
              <div className="flex-1 font-mono text-txt overflow-hidden text-ellipsis whitespace-nowrap text-sm">
                {buildReferralInviteLoginUrl(pageOrigin, referralMe.code)}
              </div>
              <Button
                variant="secondary"
                className="shrink-0"
                onClick={() => {
                  void (async () => {
                    if (!pageOrigin) {
                      toast.error(
                        t("cloud.affiliates.couldNotBuildInvite", {
                          defaultValue: "Could not build invite link",
                        }),
                      );
                      return;
                    }
                    const url = buildReferralInviteLoginUrl(
                      pageOrigin,
                      referralMe.code,
                    );
                    const ok = await copyTextToClipboard(url);
                    if (ok) {
                      markReferralCopied();
                      toast.success(
                        t("cloud.affiliates.inviteCopied", {
                          defaultValue: "Invite link copied!",
                        }),
                      );
                    } else {
                      toast.error(
                        t("cloud.affiliates.couldNotCopy", {
                          defaultValue: "Could not copy to clipboard",
                        }),
                      );
                    }
                  })();
                }}
              >
                {referralCopied ? (
                  <CheckCircle2 className="h-4 w-4 mr-2 text-status-success" />
                ) : (
                  <Copy className="h-4 w-4 mr-2" />
                )}
                {referralCopied
                  ? t("cloud.affiliates.copied", { defaultValue: "Copied" })
                  : t("cloud.affiliates.copy", { defaultValue: "Copy" })}
              </Button>
            </div>
          </>
        )}
      </BrandCard>

      {/* Affiliate Link */}
      <BrandCard corners={false}>
        <h3 className="text-lg font-semibold text-txt-strong mb-1">
          {t("cloud.affiliates.yourAffiliateLink", {
            defaultValue: "Your Affiliate Link",
          })}
        </h3>
        <p className="text-sm text-muted mb-4">
          {t("cloud.affiliates.yourAffiliateLinkDesc", {
            defaultValue:
              "Copy this link and share it anywhere. Users who sign up with it are tracked as your affiliate signups for marked-up top-ups and MCP usage—not the same as friend invites above.",
          })}
        </p>

        <div className="flex items-center gap-3 bg-bg-hover border border-border rounded-sm p-3">
          <LinkIcon className="h-5 w-5 text-muted shrink-0" />
          <div className="flex-1 font-mono text-txt overflow-hidden text-ellipsis whitespace-nowrap text-sm">
            {typeof window !== "undefined"
              ? `${window.location.origin}/login?affiliate=${affiliateData?.code}`
              : `${getAppUrl()}/login?affiliate=${affiliateData?.code}`}
          </div>
          <Button
            variant="secondary"
            className="shrink-0"
            onClick={handleCopyLink}
          >
            {copied ? (
              <CheckCircle2 className="h-4 w-4 mr-2 text-status-success" />
            ) : (
              <Copy className="h-4 w-4 mr-2" />
            )}
            {copied
              ? t("cloud.affiliates.copied", { defaultValue: "Copied" })
              : t("cloud.affiliates.copy", { defaultValue: "Copy" })}
          </Button>
        </div>
      </BrandCard>

      {/* Markup Configuration */}
      <BrandCard corners={false}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-txt-strong mb-1">
              {t("cloud.affiliates.feeMarkupSetting", {
                defaultValue: "Fee Markup Setting",
              })}
            </h3>
            <p className="text-sm text-muted max-w-xl">
              {t("cloud.affiliates.feeMarkupDesc", {
                defaultValue:
                  "Set the exact percentage you want to charge your referred users on top of base elizaOS prices. This fee applies to credit top-ups and exact usage cost for MCPs/Agents.",
              })}
            </p>
          </div>

          <div className="p-3 bg-bg-hover border border-border rounded-sm text-center min-w-[120px]">
            <span className="block text-xs text-muted mb-1">
              {t("cloud.affiliates.currentMarkup", {
                defaultValue: "Current Markup",
              })}
            </span>
            <span className="block text-xl font-bold text-accent">
              {affiliateData?.markup_percent}%
            </span>
          </div>
        </div>

        <div className="flex items-end gap-4 max-w-md mt-6">
          <div className="flex-1">
            <label
              htmlFor="affiliate-markup-percent"
              className="text-sm text-muted mb-2 block"
            >
              {t("cloud.affiliates.markupPercentLabel", {
                defaultValue: "Your Markup Percentage (0 - 1000%)",
              })}
            </label>
            <Input
              id="affiliate-markup-percent"
              type="number"
              value={markupPercent}
              onChange={(e) => setMarkupPercent(e.target.value)}
              className="bg-bg-hover border-border text-txt font-mono"
              min={0}
              max={1000}
              step={0.1}
            />
          </div>
          <Button
            onClick={handleSaveMarkup}
            disabled={
              isSaving || markupPercent === affiliateData?.markup_percent
            }
            className="min-w-[100px]"
          >
            {isSaving
              ? t("cloud.affiliates.saving", { defaultValue: "Saving..." })
              : t("cloud.affiliates.saveConfig", {
                  defaultValue: "Save Config",
                })}
          </Button>
        </div>

        <div className="mt-4 p-4 rounded-sm bg-status-warning-bg border border-status-warning/20 flex gap-3 text-sm">
          <AlertTriangle className="h-5 w-5 text-status-warning shrink-0" />
          <div className="text-status-warning">
            <strong>
              {t("cloud.affiliates.pricingExampleLabel", {
                defaultValue: "Pricing Example:",
              })}
            </strong>{" "}
            {t("cloud.affiliates.pricingExampleBody", {
              defaultValue:
                "If an API normally costs 10 credits and you set a 20% markup, your user pays 12 credits. You will earn exactly 2 credits which drops instantly into your redeemable token balance.",
            })}
          </div>
        </div>
      </BrandCard>

      {/* API Integration Snippet */}
      <BrandCard corners={false}>
        <h3 className="text-lg font-semibold text-txt-strong mb-1">
          {t("cloud.affiliates.devApiTitle", {
            defaultValue: "Developer API Integration (SKUs)",
          })}
        </h3>
        <p className="text-sm text-muted mb-4">
          {t("cloud.affiliates.devApiDesc", {
            defaultValue:
              "Embed your affiliate code directly into your API calls. All users passing your code header will automatically generate marked-up revenue for you on every inference.",
          })}
        </p>

        <div className="bg-card rounded-sm border border-border overflow-hidden relative group">
          <div className="flex items-center justify-between px-4 py-2 border-b border-border bg-bg-muted">
            <span className="text-xs font-mono text-muted">
              {t("cloud.affiliates.curlExample", {
                defaultValue: "cURL Example",
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0"
              onClick={() => {
                void (async () => {
                  const codeSnippet = `curl -X POST https://api.elizacloud.ai/v1/chat/completions \\
  -H "Authorization: Bearer YOUR_API_KEY" \\
  -H "X-Affiliate-Code: ${affiliateData?.code || "YOUR_CODE_HERE"}" \\
  -d '{
    "model": "google/gemini-2.5-flash",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'`;
                  const ok = await copyTextToClipboard(codeSnippet);
                  if (ok) {
                    toast.success(
                      t("cloud.affiliates.snippetCopied", {
                        defaultValue: "Code snippet copied!",
                      }),
                    );
                  } else {
                    toast.error(
                      t("cloud.affiliates.couldNotCopy", {
                        defaultValue: "Could not copy to clipboard",
                      }),
                    );
                  }
                })();
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
          <pre className="p-4 overflow-x-auto text-sm font-mono text-txt leading-relaxed">
            <span className="text-status-success">curl</span> -X POST
            https://api.elizacloud.ai/v1/chat/completions \<br />
            {"  "}-H{" "}
            <span className="text-status-warning">
              "Authorization: Bearer YOUR_API_KEY"
            </span>{" "}
            \
            <br />
            {"  "}-H{" "}
            <span className="text-status-warning">
              "X-Affiliate-Code:{" "}
              <span className="text-accent break-all">
                {affiliateData?.code || "YOUR_CODE_HERE"}
              </span>
              "
            </span>{" "}
            \<br />
            {"  "}-d{" "}
            <span className="text-status-warning">
              '{"{"}
              <br />
              {"    "}"model": "google/gemini-2.5-flash",
              <br />
              {"    "}"messages": [{"{"}"role": "user", "content": "Hello!"{"}"}
              ]<br />
              {"  }"}'
            </span>
          </pre>
        </div>
      </BrandCard>
    </div>
  );
}
