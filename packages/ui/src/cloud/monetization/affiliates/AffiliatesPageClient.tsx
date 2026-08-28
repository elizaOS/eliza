/**
 * Affiliates & Referrals client.
 *
 * Data: GET `/api/v1/affiliates` (auto-create on first load via POST), POST/PUT
 * `/api/v1/affiliates` (markup), GET `/api/v1/referrals` (via
 * {@link useDashboardReferralMe}). Copyable links preserve the dashboard-card
 * layout while exposing wrapping URLs, precise copy controls, and live status.
 * Markup is a SettingsInputRow; the surrounding canonical Card chrome and save
 * button stay.
 */

"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  Link as LinkIcon,
  Percent,
  UserCog,
  Users,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
// Deep primitive/brand imports per the packages/ui extension rules — the
// root cloud-ui barrel would drag the entire kit into this chunk graph.
import { Button, Skeleton } from "../../../cloud-ui/components/primitives";
import { SettingsInputRow } from "../../../components/settings/settings-agent-rows";
import { SettingsRow } from "../../../components/settings/settings-layout";
import { Alert } from "../../../components/ui/alert";
import { Card } from "../../../components/ui/card";
import { TextLink } from "../../../components/ui/text-link";
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

function buildAffiliateLoginUrl(origin: string, code: string): string {
  return `${origin.replace(/\/$/, "")}/login?affiliate=${encodeURIComponent(code)}`;
}

export function AffiliatesPageClient() {
  const t = useCloudT();
  const [affiliateData, setAffiliateData] = useState<AffiliateData | null>(
    null,
  );
  const [loading, setLoading] = useState(true);

  const [markupPercent, setMarkupPercent] = useState<string>("20.00");
  const [markupError, setMarkupError] = useState<string | null>(null);
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
  const pageOrigin =
    typeof window !== "undefined" ? window.location.origin : getAppUrl();
  const inviteUrl = referralMe
    ? buildReferralInviteLoginUrl(pageOrigin, referralMe.code)
    : "";
  const affiliateUrl = affiliateData
    ? buildAffiliateLoginUrl(pageOrigin, affiliateData.code)
    : "";

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

  const handleCopyInvite = async () => {
    if (!referralMe) return;
    const ok = await copyTextToClipboard(inviteUrl);
    if (ok) {
      markReferralCopied();
      toast.success(
        t("cloud.affiliates.inviteCopied", {
          defaultValue: "Invite link copied",
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

  const handleCopyLink = async () => {
    if (!affiliateData) return;
    const ok = await copyTextToClipboard(affiliateUrl);
    if (ok) {
      markAffiliateCopied();
      toast.success(
        t("cloud.affiliates.affiliateLinkCopied", {
          defaultValue: "Affiliate link copied",
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
      setMarkupError(
        t("cloud.affiliates.invalidMarkup", {
          defaultValue: "Enter a percentage from 0 to 1000",
        }),
      );
      document.getElementById("cloud-affiliates-markup-percent")?.focus();
      return;
    }
    setMarkupError(null);

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
          defaultValue: "Markup saved",
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
        <Skeleton className="h-44" />
        <Skeleton className="h-36" />
        <Skeleton className="h-44" />
      </div>
    );
  }

  const copyStatus =
    referralCopied && copied
      ? t("cloud.affiliates.bothLinksCopied", {
          defaultValue: "Invite link copied. Affiliate link copied",
        })
      : referralCopied
        ? t("cloud.affiliates.inviteCopied", {
            defaultValue: "Invite link copied",
          })
        : copied
          ? t("cloud.affiliates.affiliateLinkCopied", {
              defaultValue: "Affiliate link copied",
            })
          : "";
  const inviteCopyLabel = referralCopied
    ? t("cloud.affiliates.copiedInviteLinkAria", {
        defaultValue: "Copied invite link",
      })
    : t("cloud.affiliates.copyInviteLinkAria", {
        defaultValue: "Copy link (invite)",
      });
  const affiliateCopyLabel = copied
    ? t("cloud.affiliates.copiedAffiliateLinkAria", {
        defaultValue: "Copied affiliate link",
      })
    : t("cloud.affiliates.copyAffiliateLinkAria", {
        defaultValue: "Copy link (affiliate)",
      });

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto">
      <p role="status" aria-live="polite" className="sr-only">
        {copyStatus}
      </p>
      {/* Introduction Banner */}
      <Card variant="brand" className="relative">
        <div className="flex items-start gap-3">
          <UserCog className="size-5 text-accent mt-0.5 shrink-0" />
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
                to="/cloud/monetization"
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
      </Card>

      {/* Referral invite: uses GET /api/v1/referrals (parallel to affiliate
          fetch, own loading state). Different URL (?ref= vs ?affiliate=),
          economics, and copy from the affiliate card below. */}
      <Card variant="brand">
        <div className="flex items-start gap-3 mb-4">
          <Users className="size-5 text-accent mt-0.5 shrink-0" />
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
          <Skeleton className="h-14" />
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
          <Alert variant="dashboardWarning">
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
              <TextLink
                variant="accent"
                href="mailto:support@eliza.cloud?subject=Referral%20code%20inactive"
                className="text-txt-strong hover:opacity-75"
              >
                {t("cloud.affiliates.emailSupport", {
                  defaultValue: "email support@eliza.cloud",
                })}
              </TextLink>
              .
            </p>
            <p className="mt-2 font-mono text-xs text-muted break-all">
              {buildReferralInviteLoginUrl(pageOrigin, referralMe.code)}
            </p>
          </Alert>
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
            <SettingsRow
              icon={LinkIcon}
              iconClassName="text-accent/60"
              label={
                <span className="break-all font-mono font-normal text-txt">
                  {inviteUrl}
                </span>
              }
              control={
                <Button
                  variant="secondary"
                  size="sm"
                  aria-label={inviteCopyLabel}
                  data-testid="cloud-affiliates-copy-invite"
                  onClick={() => {
                    void handleCopyInvite();
                  }}
                >
                  {referralCopied ? (
                    <CheckCircle2
                      className="size-4 mr-2 text-status-success"
                      aria-hidden
                    />
                  ) : (
                    <Copy className="size-4 mr-2" aria-hidden />
                  )}
                  {referralCopied
                    ? t("cloud.affiliates.copied", { defaultValue: "Copied" })
                    : t("cloud.affiliates.copyLink", {
                        defaultValue: "Copy link",
                      })}
                </Button>
              }
            />
          </>
        )}
      </Card>

      {/* Affiliate Link */}
      <Card variant="brand">
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

        <SettingsRow
          icon={LinkIcon}
          label={
            <span className="break-all font-mono font-normal text-txt">
              {affiliateUrl}
            </span>
          }
          control={
            <Button
              variant="secondary"
              size="sm"
              aria-label={affiliateCopyLabel}
              data-testid="cloud-affiliates-copy-affiliate"
              onClick={() => {
                void handleCopyLink();
              }}
            >
              {copied ? (
                <CheckCircle2
                  className="size-4 mr-2 text-status-success"
                  aria-hidden
                />
              ) : (
                <Copy className="size-4 mr-2" aria-hidden />
              )}
              {copied
                ? t("cloud.affiliates.copied", { defaultValue: "Copied" })
                : t("cloud.affiliates.copyLink", {
                    defaultValue: "Copy link",
                  })}
            </Button>
          }
        />
      </Card>

      {/* Markup Configuration */}
      <Card variant="brand">
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

          <Card
            surface="raised"
            border="standard"
            padding="default"
            className="min-w-[120px] text-center"
          >
            <span className="block text-xs text-muted mb-1">
              {t("cloud.affiliates.currentMarkup", {
                defaultValue: "Current Markup",
              })}
            </span>
            <span className="block text-xl font-bold text-accent">
              {affiliateData?.markup_percent}%
            </span>
          </Card>
        </div>

        <div className="mt-6 max-w-md space-y-3">
          <SettingsInputRow
            agentId="cloud-affiliates-markup-percent"
            group="cloud-affiliates"
            icon={Percent}
            type="number"
            inputMode="decimal"
            label={t("cloud.affiliates.markupPercentLabel", {
              defaultValue: "Markup percentage",
            })}
            description={t("cloud.affiliates.markupPercentHelp", {
              defaultValue:
                "0–1000. Added on top of base prices for referred users.",
            })}
            value={markupPercent}
            onValueChange={(next) => {
              setMarkupError(null);
              setMarkupPercent(next);
            }}
            disabled={isSaving}
            error={markupError ?? undefined}
            placeholder="20.00"
            inputClassName="text-base tabular-nums sm:text-sm"
            testId="cloud-affiliates-markup-percent"
          />
          <div className="flex justify-end">
            <Button
              onClick={handleSaveMarkup}
              disabled={
                isSaving || markupPercent === affiliateData?.markup_percent
              }
              className="min-w-[100px]"
            >
              {isSaving
                ? t("cloud.affiliates.saving", { defaultValue: "Saving" })
                : t("cloud.affiliates.saveConfig", {
                    defaultValue: "Save markup",
                  })}
            </Button>
          </div>
        </div>

        <Alert variant="dashboardWarning" className="mt-4 flex gap-3">
          <AlertTriangle className="size-5 text-status-warning shrink-0" />
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
        </Alert>
      </Card>

      {/* API Integration Snippet */}
      <Card variant="brand">
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

        <Card variant="codeFrame" className="group relative overflow-hidden">
          <Card
            variant="codeHeader"
            className="flex items-center justify-between px-4 py-2"
          >
            <span className="text-xs font-mono text-muted">
              {t("cloud.affiliates.curlExample", {
                defaultValue: "cURL Example",
              })}
            </span>
            <Button
              variant="ghost"
              size="sm"
              className="size-6 p-0"
              onClick={() => {
                void (async () => {
                  const codeSnippet = `curl -X POST https://api.eliza.app/v1/chat/completions \\
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
              <Copy className="size-3" />
            </Button>
          </Card>
          <pre className="p-4 overflow-x-auto text-sm font-mono text-txt leading-relaxed">
            <span className="text-status-success">curl</span> -X POST
            https://api.eliza.app/v1/chat/completions \<br />
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
        </Card>
      </Card>
    </div>
  );
}
