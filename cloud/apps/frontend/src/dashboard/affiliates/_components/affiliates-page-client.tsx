"use client";

import { BrandCard, Button, Input, Skeleton } from "@elizaos/cloud-ui";
import { AlertTriangle, CheckCircle2, Copy, Link as LinkIcon, UserCog, Users } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useDashboardReferralMe } from "./use-dashboard-referral-me";
import { COPY_FEEDBACK_DURATION_MS } from "@/lib/constants/copy-feedback";
import { getAppUrl } from "@/lib/utils/app-url";
import { copyTextToClipboard } from "@/lib/utils/copy-to-clipboard";
import { buildReferralInviteLoginUrl } from "@/lib/utils/referral-invite-url";

interface AffiliateData {
  id: string;
  code: string;
  markup_percent: string;
  is_active: boolean;
}

export function AffiliatesPageClient() {
  const [affiliateData, setAffiliateData] = useState<AffiliateData | null>(null);
  const [loading, setLoading] = useState(true);

  const [markupPercent, setMarkupPercent] = useState<string>("20.00");
  const [isSaving, setIsSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [referralCopied, setReferralCopied] = useState(false);
  const affiliateCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const referralCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const {
    referralMe,
    loadingReferral,
    referralFetchFailed,
    refetch: refetchReferral,
  } = useDashboardReferralMe();

  const createAffiliateCode = useCallback(async (initialMarkup = 20) => {
    const res = await fetch("/api/v1/affiliates", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ markupPercent: initialMarkup }),
    });

    if (!res.ok) {
      throw new Error("Failed to create affiliate code");
    }

    const data = await res.json();
    setAffiliateData(data.code);
    setMarkupPercent(data.code.markup_percent);
    return data.code as AffiliateData;
  }, []);

  const fetchAffiliateData = useCallback(async () => {
    try {
      const res = await fetch("/api/v1/affiliates");
      if (res.ok) {
        const data = await res.json();
        if (data.code) {
          setAffiliateData(data.code);
          setMarkupPercent(data.code.markup_percent);
        } else {
          await createAffiliateCode();
        }
      }
    } catch (e) {
      console.error("Failed to load affiliate data", e);
    } finally {
      setLoading(false);
    }
  }, [createAffiliateCode]);

  useEffect(() => {
    fetchAffiliateData();
  }, [fetchAffiliateData]);

  useEffect(
    () => () => {
      if (affiliateCopyTimerRef.current) {
        clearTimeout(affiliateCopyTimerRef.current);
      }
      if (referralCopyTimerRef.current) {
        clearTimeout(referralCopyTimerRef.current);
      }
    },
    [],
  );

  const handleCopyLink = async () => {
    if (!affiliateData) return;
    const url = `${window.location.origin}/login?affiliate=${affiliateData.code}`;
    const ok = await copyTextToClipboard(url);
    if (ok) {
      setCopied(true);
      toast.success("Link copied to clipboard!");
      if (affiliateCopyTimerRef.current) {
        clearTimeout(affiliateCopyTimerRef.current);
      }
      affiliateCopyTimerRef.current = setTimeout(() => setCopied(false), COPY_FEEDBACK_DURATION_MS);
    } else {
      toast.error("Could not copy to clipboard");
    }
  };

  const handleSaveMarkup = async () => {
    const numericValue = parseFloat(markupPercent);
    if (isNaN(numericValue) || numericValue < 0 || numericValue > 1000) {
      toast.error("Invalid markup. Must be between 0 and 1000%.");
      return;
    }

    setIsSaving(true);
    try {
      const res = await fetch("/api/v1/affiliates", {
        method: affiliateData ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ markupPercent: numericValue }),
      });

      if (res.ok) {
        const data = await res.json();
        setAffiliateData(data.code);
        setMarkupPercent(data.code.markup_percent);
        toast.success("Markup percentage updated!");
      } else {
        const err = await res.json();
        toast.error(err.error || "Failed to save markup");
      }
    } catch (_e) {
      toast.error("An unexpected error occurred");
    } finally {
      setIsSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col gap-6 max-w-4xl mx-auto">
        <Skeleton className="h-44 rounded-lg" />
        <Skeleton className="h-36 rounded-lg" />
        <Skeleton className="h-44 rounded-lg" />
      </div>
    );
  }

  const pageOrigin = typeof window !== "undefined" ? window.location.origin : getAppUrl();

  return (
    <div className="flex flex-col gap-6 max-w-4xl mx-auto">
      {/* Introduction Banner */}
      <BrandCard className="relative" corners={false}>
        <div className="flex items-start gap-3">
          <UserCog className="h-5 w-5 text-[#FF5800] mt-0.5 shrink-0" />
          <div>
            <h3 className="text-xl font-semibold text-white mb-2">Affiliate Program</h3>
            <p className="text-sm text-white/60 mb-2">
              Share your customized affiliate link with your users and partners to earn a percentage
              of their marked-up top-ups and MCP usage.
            </p>
            <p className="text-sm text-white/60">
              When a user signs up using your link, you get a direct cut (your markup percentage) of
              their activity forever. You can track this revenue in your
              <Link to="/dashboard/earnings" className="text-[#FF5800] hover:underline mx-1">
                Earnings
              </Link>
              dashboard, which can be withdrawn to any EVM or Solana wallet as $ELIZA tokens.
            </p>
          </div>
        </div>
      </BrandCard>

      {/* Referral invite: uses GET /api/v1/referrals (parallel to affiliate fetch, own loading state).
          WHY separate from affiliate card: Different URL (?ref= vs ?affiliate=), economics, and copy.
          WHY cyan accent: Visually distinct from orange affiliate branding so users don’t merge the two mentally. */}
      <BrandCard corners={false} className="border-l-4 border-l-cyan-500/60 border border-white/10">
        <div className="flex items-start gap-3 mb-4">
          <Users className="h-5 w-5 text-cyan-400 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-semibold text-white mb-1">Invite friends</h3>
            <p className="text-sm text-white/60">
              Share your invite link—you both earn bonus credits when they sign up, and you earn a
              share of their purchases on Eliza Cloud.
            </p>
          </div>
        </div>

        {loadingReferral ? (
          <Skeleton className="h-14 rounded-lg" />
        ) : referralFetchFailed || !referralMe ? (
          <div className="flex items-center gap-3">
            <p className="text-sm text-white/50">Could not load your invite link.</p>
            <Button
              variant="secondary"
              size="sm"
              className="shrink-0 bg-cyan-500/15 hover:bg-cyan-500/25 text-white border-cyan-500/30"
              onClick={() => refetchReferral()}
            >
              Retry
            </Button>
          </div>
        ) : !referralMe.is_active ? (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-100/90">
            <p className="font-medium text-amber-100">Invite link inactive</p>
            <p className="mt-1 text-amber-100/80">
              Your referral code is turned off for new signups. Only an Eliza Cloud administrator
              can re-enable it. If you believe this is a mistake,{" "}
              <a
                href="mailto:support@eliza.cloud?subject=Referral%20code%20inactive"
                className="text-cyan-300 underline hover:text-cyan-200"
              >
                email support@eliza.cloud
              </a>
              .
            </p>
            <p className="mt-2 font-mono text-xs text-white/50 break-all">
              {buildReferralInviteLoginUrl(pageOrigin, referralMe.code)}
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-cyan-200/70 mb-3">
              {referralMe.total_referrals === 0
                ? "No friends have joined yet—share your link to get started."
                : referralMe.total_referrals === 1
                  ? "1 friend has joined with your link."
                  : `${referralMe.total_referrals} friends have joined with your link.`}
            </p>
            <div className="flex items-center gap-3 bg-white/5 border border-cyan-500/20 rounded-lg p-3">
              <LinkIcon className="h-5 w-5 text-cyan-400/60 shrink-0" />
              <div className="flex-1 font-mono text-white/80 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
                {buildReferralInviteLoginUrl(pageOrigin, referralMe.code)}
              </div>
              <Button
                variant="secondary"
                className="shrink-0 bg-cyan-500/15 hover:bg-cyan-500/25 text-white border-cyan-500/30"
                onClick={() => {
                  void (async () => {
                    if (!pageOrigin) {
                      toast.error("Could not build invite link");
                      return;
                    }
                    const url = buildReferralInviteLoginUrl(pageOrigin, referralMe.code);
                    const ok = await copyTextToClipboard(url);
                    if (ok) {
                      setReferralCopied(true);
                      toast.success("Invite link copied!");
                      if (referralCopyTimerRef.current) {
                        clearTimeout(referralCopyTimerRef.current);
                      }
                      referralCopyTimerRef.current = setTimeout(
                        () => setReferralCopied(false),
                        COPY_FEEDBACK_DURATION_MS,
                      );
                    } else {
                      toast.error("Could not copy to clipboard");
                    }
                  })();
                }}
              >
                {referralCopied ? (
                  <CheckCircle2 className="h-4 w-4 mr-2 text-green-400" />
                ) : (
                  <Copy className="h-4 w-4 mr-2" />
                )}
                {referralCopied ? "Copied" : "Copy"}
              </Button>
            </div>
          </>
        )}
      </BrandCard>

      {/* Affiliate Link */}
      <BrandCard corners={false}>
        <h3 className="text-lg font-semibold text-white mb-1">Your Affiliate Link</h3>
        <p className="text-sm text-white/60 mb-4">
          Copy this link and share it anywhere. Users who sign up with it are tracked as your
          affiliate signups for marked-up top-ups and MCP usage—not the same as friend invites
          above.
        </p>

        <div className="flex items-center gap-3 bg-white/5 border border-white/10 rounded-lg p-3">
          <LinkIcon className="h-5 w-5 text-white/40 shrink-0" />
          <div className="flex-1 font-mono text-white/80 overflow-hidden text-ellipsis whitespace-nowrap text-sm">
            {typeof window !== "undefined"
              ? `${window.location.origin}/login?affiliate=${affiliateData?.code}`
              : `${getAppUrl()}/login?affiliate=${affiliateData?.code}`}
          </div>
          <Button
            variant="secondary"
            className="shrink-0 bg-white/10 hover:bg-white/20 text-white border-transparent"
            onClick={handleCopyLink}
          >
            {copied ? (
              <CheckCircle2 className="h-4 w-4 mr-2 text-green-400" />
            ) : (
              <Copy className="h-4 w-4 mr-2" />
            )}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      </BrandCard>

      {/* Markup Configuration */}
      <BrandCard corners={false}>
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="text-lg font-semibold text-white mb-1">Fee Markup Setting</h3>
            <p className="text-sm text-white/60 max-w-xl">
              Set the exact percentage you want to charge your referred users on top of base elizaOS
              prices. This fee applies to credit top-ups and exact usage cost for MCPs/Agents.
            </p>
          </div>

          <div className="p-3 bg-white/5 border border-white/10 rounded-lg text-center min-w-[120px]">
            <span className="block text-xs text-white/40 mb-1">Current Markup</span>
            <span className="block text-xl font-bold text-[#FF5800]">
              {affiliateData?.markup_percent}%
            </span>
          </div>
        </div>

        <div className="flex items-end gap-4 max-w-md mt-6">
          <div className="flex-1">
            <label className="text-sm text-white/60 mb-2 block">
              Your Markup Percentage (0 - 1000%)
            </label>
            <Input
              type="number"
              value={markupPercent}
              onChange={(e) => setMarkupPercent(e.target.value)}
              className="bg-white/5 border-white/10 text-white font-mono"
              min={0}
              max={1000}
              step={0.1}
            />
          </div>
          <Button
            onClick={handleSaveMarkup}
            disabled={isSaving || markupPercent === affiliateData?.markup_percent}
            className="bg-[#FF5800] hover:bg-[#FF5800]/90 text-white min-w-[100px]"
          >
            {isSaving ? "Saving..." : "Save Config"}
          </Button>
        </div>

        <div className="mt-4 p-4 rounded-lg bg-yellow-500/10 border border-yellow-500/20 flex gap-3 text-sm">
          <AlertTriangle className="h-5 w-5 text-yellow-500 shrink-0" />
          <div className="text-yellow-500/90">
            <strong>Pricing Example:</strong> If an API normally costs 10 credits and you set a 20%
            markup, your user pays 12 credits. You will earn exactly 2 credits which drops instantly
            into your redeemable token balance.
          </div>
        </div>
      </BrandCard>

      {/* API Integration Snippet */}
      <BrandCard corners={false}>
        <h3 className="text-lg font-semibold text-white mb-1">Developer API Integration (SKUs)</h3>
        <p className="text-sm text-white/60 mb-4">
          Embed your affiliate code directly into your API calls. All users passing your code header
          will automatically generate marked-up revenue for you on every inference.
        </p>

        <div className="bg-[#0A0A0A] rounded-lg border border-white/10 overflow-hidden relative group">
          <div className="flex items-center justify-between px-4 py-2 border-b border-white/10 bg-white/[0.02]">
            <span className="text-xs font-mono text-white/40">cURL Example</span>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 w-6 p-0 text-white/40 hover:text-white"
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
                    toast.success("Code snippet copied!");
                  } else {
                    toast.error("Could not copy to clipboard");
                  }
                })();
              }}
            >
              <Copy className="h-3 w-3" />
            </Button>
          </div>
          <pre className="p-4 overflow-x-auto text-sm font-mono text-white/80 leading-relaxed">
            <span className="text-green-400">curl</span> -X POST
            https://api.elizacloud.ai/v1/chat/completions \<br />
            {"  "}-H <span className="text-yellow-300">"Authorization: Bearer YOUR_API_KEY"</span> \
            <br />
            {"  "}-H{" "}
            <span className="text-yellow-300">
              "X-Affiliate-Code:{" "}
              <span className="text-[#FF5800] break-all">
                {affiliateData?.code || "YOUR_CODE_HERE"}
              </span>
              "
            </span>{" "}
            \<br />
            {"  "}-d{" "}
            <span className="text-yellow-300">
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
