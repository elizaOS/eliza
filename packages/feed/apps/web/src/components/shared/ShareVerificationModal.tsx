"use client";

import { cn } from "@feed/shared";
import { Check, X as XIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { getAuthToken } from "@/lib/auth";
import { apiUrl } from "@/utils/api-url";

/**
 * Share verification modal component for verifying external shares.
 *
 * Allows users to paste the URL of their shared post to verify the share
 * and earn reputation. Supports Twitter/X and Farcaster platforms. Shows
 * platform-specific placeholder URLs and success/error feedback.
 *
 * @param props - ShareVerificationModal component props
 * @returns Share verification modal element or null if not open
 *
 * @example
 * ```tsx
 * <ShareVerificationModal
 *   isOpen={isOpen}
 *   onClose={() => setIsOpen(false)}
 *   shareId="share-123"
 *   platform="twitter"
 *   userId="user-456"
 * />
 * ```
 */
interface ShareVerificationModalProps {
  isOpen: boolean;
  onClose: () => void;
  shareId: string;
  platform: "twitter" | "farcaster";
  userId: string;
  onSuccess?: (reputationAwarded: number) => void;
}

export function ShareVerificationModal({
  isOpen,
  onClose,
  shareId,
  platform,
  userId,
  onSuccess,
}: ShareVerificationModalProps) {
  const [postUrl, setPostUrl] = useState("");
  const [verifying, setVerifying] = useState(false);

  if (!isOpen) return null;

  const handleVerify = async () => {
    if (!postUrl.trim()) {
      toast.error("Please enter the URL to your post");
      return;
    }

    setVerifying(true);

    const token = getAuthToken();
    const headers: HeadersInit = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    const response = await fetch(
      apiUrl(`/api/users/${encodeURIComponent(userId)}/verify-share`),
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          shareId,
          platform,
          postUrl: postUrl.trim(),
        }),
      },
    );

    const data = await response.json();

    if (!response.ok) {
      toast.error(data.message || data.error || "Failed to verify share");
      setVerifying(false);
      return;
    }

    if (data.verified) {
      const reputationAwarded = Number(data.reputation?.awarded ?? 0);
      const reputationMessage =
        reputationAwarded > 0
          ? `Share verified! You earned ${reputationAwarded} reputation.`
          : "Share verified! Thank you for sharing!";
      toast.success(reputationMessage);
      onSuccess?.(reputationAwarded);

      setTimeout(() => {
        // Reload the page to update points display
        window.location.reload();
      }, 2000);
    } else {
      toast.error(
        data.message || "Could not verify your post. Please check the URL.",
      );
    }
    setVerifying(false);
  };

  const platformName = platform === "twitter" ? "X" : "Farcaster";
  const placeholderUrl =
    platform === "twitter"
      ? "https://x.com/username/status/1234567890"
      : "https://farcaster.xyz/username/0x1234abcd";

  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 p-0 backdrop-blur-sm md:p-4"
      onClick={onClose}
    >
      <div
        className="flex h-full w-full flex-col bg-background md:h-auto md:max-h-[90vh] md:w-auto md:min-w-[480px] md:max-w-md md:rounded-xl md:border md:border-border"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between border-border border-b p-6">
          <h2 className="font-bold text-xl">Verify Your Share</h2>
          <button
            onClick={onClose}
            className="rounded-full p-2 transition-colors hover:bg-muted"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-6">
          <div>
            <p className="mb-4 text-muted-foreground text-sm">
              Help us verify that you shared to {platformName}! Paste the URL to
              your post below.
            </p>

            <label htmlFor="postUrl" className="mb-2 block font-medium text-sm">
              Post URL
            </label>
            <input
              id="postUrl"
              type="url"
              value={postUrl}
              onChange={(e) => setPostUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") handleVerify();
              }}
              placeholder={placeholderUrl}
              className="w-full rounded-lg bg-sidebar-accent/50 px-4 py-2 focus:border-border focus:outline-none"
              disabled={verifying}
            />
          </div>

          <div className="rounded-lg border border-primary/20 bg-primary/10 p-3">
            <p className="text-muted-foreground text-xs">
              <strong>Tip:</strong> After posting, copy the URL from your
              browser&apos;s address bar or use the &quot;Copy link&quot; option
              on your post.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="shrink-0 border-border border-t p-6">
          <div className="flex gap-2">
            <button
              onClick={handleVerify}
              disabled={verifying || !postUrl.trim()}
              className={cn(
                "flex-1 rounded-lg px-4 py-3 font-semibold transition-colors",
                "bg-primary text-primary-foreground hover:bg-primary/90",
                "disabled:cursor-not-allowed disabled:opacity-50",
                "flex items-center justify-center gap-2",
              )}
            >
              {verifying ? (
                <span>Verifying...</span>
              ) : (
                <>
                  <Check className="h-4 w-4" />
                  <span>Verify</span>
                </>
              )}
            </button>

            <button
              onClick={onClose}
              disabled={verifying}
              className="rounded-lg bg-muted px-4 py-3 font-semibold transition-colors hover:bg-muted/70"
            >
              Skip
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
