"use client";

import {
  FEED_POINTS_SYMBOL,
  getReferralUrl,
  logger,
  trackExternalShare,
} from "@feed/shared";
import { Download, LogOut, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { CategoryPnLShareCard } from "@/components/markets/CategoryPnLShareCard";
import { PortfolioPnLShareCard } from "@/components/markets/PortfolioPnLShareCard";
import { useAuth } from "@/hooks/useAuth";
import type { PortfolioBreakdownSnapshot } from "@/hooks/usePortfolioPnL";
import { useTwitterAuth } from "@/hooks/useTwitterAuth";
import type { User } from "@/stores/authStore";
import type { MarketCategory } from "@/types/markets";
import { apiUrl } from "@/utils/api-url";

/**
 * Category PnL data structure for PnL share modal.
 */
interface CategoryPnLData {
  unrealizedPnL: number;
  positionCount: number;
  totalValue?: number;
  categorySpecific?: {
    openInterest?: number;
    totalShares?: number;
    totalInvested?: number;
  };
}

/**
 * PnL share modal component for sharing portfolio or category PnL.
 *
 * Provides a modal interface for sharing PnL data on social media (Twitter,
 * Farcaster). Generates shareable images, handles image download, and supports
 * direct posting to Twitter. Includes Twitter authentication and share tracking.
 *
 * Features:
 * - Portfolio or category PnL sharing
 * - Shareable image generation
 * - Image download
 * - Twitter posting
 * - Farcaster sharing
 * - Twitter authentication
 * - Share tracking
 * - Loading states
 * - Error handling
 * - Body scroll lock and escape key handling
 *
 * @param props - PnLShareModal component props
 * @returns PnL share modal element or null if not open
 *
 * @example
 * ```tsx
 * <PnLShareModal
 *   isOpen={showModal}
 *   onClose={() => setShowModal(false)}
 *   type="portfolio"
 *   portfolioData={portfolioData}
 *   user={userData}
 * />
 * ```
 */
interface PnLShareModalProps {
  isOpen: boolean;
  onClose: () => void;
  type: "portfolio" | "category";
  portfolioData?: PortfolioBreakdownSnapshot | null;
  categoryData?: CategoryPnLData | null;
  category?: MarketCategory;
  user: User | null;
}

/**
 * Farcaster icon component for social sharing.
 *
 * @param props - FarcasterIcon component props
 * @returns Farcaster icon SVG element
 */
function FarcasterIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 1000 1000"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M257.778 155.556H742.222V844.444H671.111V528.889H670.414C662.554 441.677 589.258 373.333 500 373.333C410.742 373.333 337.446 441.677 329.586 528.889H328.889V844.444H257.778V155.556Z" />
      <path d="M128.889 253.333L157.778 351.111H182.222V844.444H128.889V253.333Z" />
      <path d="M871.111 253.333L842.222 351.111H817.778V844.444H871.111V253.333Z" />
    </svg>
  );
}

/**
 * Category labels for display.
 */
const categoryLabels: Record<MarketCategory, string> = {
  perps: "Perpetual Futures",
  predictions: "Prediction Markets",
};

export function PnLShareModal({
  isOpen,
  onClose,
  type,
  portfolioData,
  categoryData,
  category = "perps",
  user,
}: PnLShareModalProps) {
  const { getAccessToken } = useAuth();
  const [isDownloading, setIsDownloading] = useState(false);
  const [sharing, setSharing] = useState<"twitter" | "farcaster" | null>(null);
  const [previewImageUrl, setPreviewImageUrl] = useState<string | null>(null);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isPostingToTwitter, setIsPostingToTwitter] = useState(false);
  const [showTwitterConfirm, setShowTwitterConfirm] = useState(false);
  const [tweetText, setTweetText] = useState("");
  const offscreenCardRef = useRef<HTMLDivElement>(null);

  // Twitter auth hook
  const {
    authStatus,
    loading: twitterAuthLoading,
    connectTwitter,
    disconnectTwitter,
  } = useTwitterAuth();

  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/markets`
      : "https://feed.market";

  const canShare = Boolean(
    user && (type === "portfolio" ? portfolioData : categoryData),
  );

  const data = type === "portfolio" ? portfolioData : categoryData;
  const categoryLabel =
    type === "category" && category ? categoryLabels[category] : "";
  const contentId = type === "portfolio" ? "portfolio-pnl" : `${category}-pnl`;

  // Generate shareable link with referral code (waitlist format)
  const shareableLink = useMemo(() => {
    if (!user?.referralCode) return null;
    // Use waitlist referral format: /?ref=CODE
    return getReferralUrl(user.referralCode);
  }, [user?.referralCode]);

  const shareText = useMemo(() => {
    const link = shareableLink || shareUrl;
    const standardMessage =
      "Join me in Feed, a real-time simulation where humans and AI agents battle across prediction markets, form alliances, and shape outcomes—together.";

    if (type === "portfolio" && portfolioData) {
      const sign = portfolioData.totalPnL >= 0 ? "+" : "-";
      return `My Feed P&L is ${sign}${FEED_POINTS_SYMBOL}${Math.abs(portfolioData.totalPnL).toFixed(2)}. Trading narratives, sharing the upside.\n\n${standardMessage}\n\n${link}`;
    }
    if (type === "category" && categoryData) {
      const sign = categoryData.unrealizedPnL >= 0 ? "+" : "-";
      return `My ${categoryLabel} P&L on Feed is ${sign}${FEED_POINTS_SYMBOL}${Math.abs(categoryData.unrealizedPnL).toFixed(2)}. Trading narratives, sharing the upside.\n\n${standardMessage}\n\n${link}`;
    }
    return `${standardMessage}\n\n${link}`;
  }, [
    type,
    portfolioData,
    categoryData,
    categoryLabel,
    shareUrl,
    shareableLink,
  ]);

  // Set initial tweet text
  useEffect(() => {
    if (shareText && !tweetText) {
      setTweetText(shareText);
    }
  }, [shareText, tweetText]);

  // Generate preview image when modal opens or data changes
  useEffect(() => {
    if (!isOpen || !canShare || !offscreenCardRef.current) {
      setPreviewImageUrl(null);
      return;
    }

    const generatePreview = async () => {
      const cardElement = offscreenCardRef.current;
      if (!cardElement) {
        setPreviewImageUrl(null);
        setIsGeneratingImage(false);
        return;
      }

      setIsGeneratingImage(true);
      const htmlToImage = await import("html-to-image");
      const dataUrl = await htmlToImage.toPng(cardElement, {
        pixelRatio: 2,
        cacheBust: true,
        backgroundColor: "#050816",
      });
      setPreviewImageUrl(dataUrl);
      setIsGeneratingImage(false);
    };

    // Small delay to ensure DOM is ready
    const timeoutId = setTimeout(generatePreview, 100);
    return () => clearTimeout(timeoutId);
  }, [isOpen, canShare]);

  if (!isOpen) return null;

  const handleDownload = async () => {
    if (!previewImageUrl) return;

    setIsDownloading(true);

    const link = document.createElement("a");
    link.href = previewImageUrl;
    link.download = `feed-${type === "portfolio" ? "pnl" : `${category}-pnl`}-${Date.now()}.png`;
    link.click();

    void trackExternalShare({
      platform: "download",
      contentType: "market",
      contentId,
      url: shareUrl,
      userId: user?.id,
    });

    toast.success("P&L card downloaded");
    setIsDownloading(false);
  };

  const handleShare = async (platform: "twitter" | "farcaster") => {
    if (!canShare || !user || !data) return;

    setSharing(platform);

    if (platform === "twitter") {
      if (!authStatus?.connected) {
        toast.info("Please connect your X account to share");
        connectTwitter(window.location.pathname);
        setSharing(null);
        return;
      }

      setShowTwitterConfirm(true);
      setSharing(null);
    } else {
      // Farcaster compose URL - uses official protocol endpoint (farcaster.xyz)
      const farcasterComposeUrl = `https://farcaster.xyz/~/compose?text=${encodeURIComponent(shareText)}&embeds[]=${encodeURIComponent(shareableLink || shareUrl)}`;
      window.open(farcasterComposeUrl, "_blank", "width=550,height=600");

      await trackExternalShare({
        platform,
        contentType: "market",
        contentId,
        url: shareableLink || shareUrl,
        userId: user?.id,
      });

      setSharing(null);
    }
  };

  const handleTwitterPost = async () => {
    if (!user || !authStatus?.connected || !shareableLink) return;

    setIsPostingToTwitter(true);

    const token = await getAccessToken();
    if (!token) {
      toast.error("Authentication required. Please log in.");
      setIsPostingToTwitter(false);
      return;
    }

    toast.info("Posting to X...");

    try {
      const tweetResponse = await fetch(apiUrl("/api/twitter/tweet"), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: tweetText,
          contentType: "market",
          contentId,
        }),
      });

      if (!tweetResponse.ok) {
        const errorData = (await tweetResponse.json()) as { error?: string };
        toast.error(errorData.error ?? "Failed to post tweet");
        return;
      }

      const tweetData = (await tweetResponse.json()) as { tweetUrl: string };

      toast.success("Successfully shared to X!");

      await trackExternalShare({
        platform: "twitter",
        contentType: "market",
        contentId,
        url: shareableLink,
        userId: user.id,
      });

      if (tweetData.tweetUrl) {
        window.open(tweetData.tweetUrl, "_blank");
      }

      setShowTwitterConfirm(false);
      onClose();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Failed to post tweet";
      logger.error(
        "Failed to post PnL to Twitter",
        { contentId, error: err },
        "PnLShareModal",
      );
      toast.error(message);
    } finally {
      setIsPostingToTwitter(false);
    }
  };

  const handleDisconnectTwitter = async () => {
    await disconnectTwitter();
    toast.success("X account disconnected");
  };

  const modalTitle =
    type === "portfolio" ? "Share Your P&L" : `Share Your ${categoryLabel} P&L`;

  const modalSubtitle =
    type === "portfolio"
      ? "Show off your Feed performance card"
      : `Show off your Feed ${category} performance`;

  return (
    <>
      {/* Off-screen card for rendering to image */}
      <div style={{ position: "absolute", left: "-9999px", top: "-9999px" }}>
        <div ref={offscreenCardRef}>
          {canShare && type === "portfolio" && portfolioData && user && (
            <PortfolioPnLShareCard data={portfolioData} user={user} />
          )}
          {canShare && type === "category" && categoryData && user && (
            <CategoryPnLShareCard
              category={category}
              data={categoryData}
              user={user}
            />
          )}
        </div>
      </div>

      {/* Modal */}
      <button
        type="button"
        aria-label="Close share modal"
        className="fixed inset-0 z-[110] bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      />
      <div className="pointer-events-none fixed inset-0 z-[111] flex items-center justify-center p-0 md:p-4">
        <div
          role="dialog"
          aria-modal="true"
          className="pointer-events-auto flex h-full w-full flex-col bg-sidebar md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-4xl md:overflow-hidden md:rounded-2xl md:border md:border-border md:shadow-2xl"
        >
          {/* Header */}
          <div className="flex shrink-0 items-start justify-between border-border border-b px-6 py-4">
            <div>
              <h2 className="font-semibold text-foreground text-xl">
                {modalTitle}
              </h2>
              <p className="text-muted-foreground text-xs">{modalSubtitle}</p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full p-2 text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground"
              aria-label="Close share modal"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Content */}
          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 py-6">
            {/* Preview Section */}
            <div className="relative aspect-[1200/630] w-full overflow-hidden rounded-xl border border-border bg-muted/30">
              {canShare ? (
                isGeneratingImage ? (
                  <div className="flex h-full items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="h-8 w-8 animate-spin rounded-full border-2 border-muted border-t-foreground" />
                      <p className="text-muted-foreground text-sm">
                        Generating preview...
                      </p>
                    </div>
                  </div>
                ) : previewImageUrl ? (
                  <img
                    src={previewImageUrl}
                    alt="P&L Card Preview"
                    className="h-full w-full object-contain"
                  />
                ) : (
                  <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                    Preparing preview...
                  </div>
                )
              ) : (
                <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                  Sign in to generate your personalized P&amp;L card.
                </div>
              )}
            </div>

            {/* Twitter Connection Status */}
            {authStatus?.connected && (
              <div className="flex items-center justify-between rounded-lg border border-border bg-muted/30 px-4 py-2">
                <div className="flex items-center gap-2">
                  <X className="h-4 w-4 text-sky-400" />
                  <span className="text-foreground text-sm">
                    Connected as{" "}
                    <span className="font-semibold">
                      @{authStatus.screenName}
                    </span>
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleDisconnectTwitter}
                  className="inline-flex items-center gap-1 text-muted-foreground text-xs transition hover:text-foreground"
                >
                  <LogOut className="h-3 w-3" />
                  Disconnect
                </button>
              </div>
            )}

            {/* Action Buttons */}
            <div className="grid grid-cols-3 gap-3">
              <button
                type="button"
                onClick={handleDownload}
                disabled={!canShare || isDownloading || !previewImageUrl}
                className="inline-flex items-center justify-center gap-2 rounded-xl bg-foreground px-4 py-3 font-semibold text-background text-sm transition hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Download className="h-4 w-4" />
                <span className="hidden sm:inline">Download</span>
              </button>

              <button
                type="button"
                onClick={() => handleShare("twitter")}
                disabled={
                  !canShare || sharing === "twitter" || twitterAuthLoading
                }
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-sidebar-accent px-4 py-3 font-semibold text-foreground text-sm transition hover:border-border hover:bg-sidebar-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <X className="h-4 w-4 text-sky-400" />
                <span className="hidden sm:inline">Share to X</span>
              </button>

              <button
                type="button"
                onClick={() => handleShare("farcaster")}
                disabled={!canShare || sharing === "farcaster"}
                className="inline-flex items-center justify-center gap-2 rounded-xl border border-border bg-sidebar-accent px-4 py-3 font-semibold text-foreground text-sm transition hover:border-border hover:bg-sidebar-accent/80 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <FarcasterIcon className="h-4 w-4 text-purple-400" />
                <span className="hidden sm:inline">Share to Farcaster</span>
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Twitter Confirmation Modal */}
      {showTwitterConfirm && (
        <>
          <button
            type="button"
            aria-label="Close X confirmation"
            className="fixed inset-0 z-[120] bg-black/80 backdrop-blur-sm"
            onClick={() => !isPostingToTwitter && setShowTwitterConfirm(false)}
          />
          <div className="pointer-events-none fixed inset-0 z-[121] flex items-center justify-center p-4">
            <div
              role="dialog"
              aria-modal="true"
              className="pointer-events-auto relative w-full max-w-2xl overflow-hidden rounded-2xl border border-border bg-sidebar shadow-2xl"
            >
              <div className="flex items-center justify-between border-border border-b px-6 py-4">
                <div className="flex items-center gap-2">
                  <X className="h-5 w-5 text-sky-400" />
                  <h2 className="font-semibold text-foreground text-xl">
                    Share to X
                  </h2>
                </div>
                <button
                  type="button"
                  onClick={() =>
                    !isPostingToTwitter && setShowTwitterConfirm(false)
                  }
                  disabled={isPostingToTwitter}
                  className="rounded-lg p-2 text-muted-foreground transition hover:bg-sidebar-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  aria-label="Close modal"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="flex flex-col gap-4 px-6 py-6">
                {/* Preview */}
                <div className="relative aspect-[1200/630] w-full overflow-hidden rounded-xl border border-border bg-muted/30">
                  {previewImageUrl ? (
                    <img
                      src={previewImageUrl}
                      alt="Tweet Preview"
                      className="h-full w-full object-contain"
                    />
                  ) : (
                    <div className="flex h-full items-center justify-center text-muted-foreground text-sm">
                      No preview available
                    </div>
                  )}
                </div>

                {/* Tweet Text Editor */}
                <div>
                  <label
                    htmlFor="tweet-text"
                    className="mb-2 block font-medium text-foreground text-sm"
                  >
                    Tweet Text
                  </label>
                  <textarea
                    id="tweet-text"
                    value={tweetText}
                    onChange={(e) => setTweetText(e.target.value)}
                    maxLength={280}
                    rows={4}
                    disabled={isPostingToTwitter}
                    className="w-full resize-none rounded-lg border border-border bg-muted/30 px-4 py-3 text-foreground placeholder-muted-foreground focus:border-border focus:outline-none focus:ring-2 focus:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                    placeholder="What's on your mind?"
                  />
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-muted-foreground text-xs">
                      {tweetText.length} / 280 characters
                    </span>
                    {tweetText.length > 280 && (
                      <span className="text-red-400 text-xs">
                        Text is too long
                      </span>
                    )}
                  </div>
                </div>

                {/* Actions */}
                <div className="flex justify-end gap-3">
                  <button
                    type="button"
                    onClick={() => setShowTwitterConfirm(false)}
                    disabled={isPostingToTwitter}
                    className="rounded-lg border border-border px-6 py-2.5 text-foreground transition hover:bg-sidebar-accent disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleTwitterPost}
                    disabled={
                      isPostingToTwitter ||
                      !tweetText.trim() ||
                      tweetText.length > 280
                    }
                    className="flex items-center gap-2 rounded-lg bg-sky-500 px-6 py-2.5 font-medium text-foreground transition hover:bg-sky-600 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isPostingToTwitter ? (
                      <>
                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-foreground/20 border-t-foreground" />
                        Posting...
                      </>
                    ) : (
                      <>
                        <X className="h-4 w-4" />
                        Post
                      </>
                    )}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </>
  );
}
