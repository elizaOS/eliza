"use client";

export const dynamic = "force-dynamic";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { NftGrid, RevealModal } from "@/components/nft";
import { PageContainer } from "@/components/shared/PageContainer";
import { useAuth } from "@/hooks/useAuth";
import { useNftMint } from "@/hooks/useNftMint";
import type { NftGalleryResponse, NftSummary } from "@/types/nft";
import { apiFetch } from "@/utils/api-fetch";
import { apiUrl } from "@/utils/api-url";

type ViewTab = "all" | "mine";

export default function NftGalleryPage() {
  const { authenticated, user } = useAuth();
  const router = useRouter();
  const {
    eligibility,
    isCheckingEligibility,
    flowState,
    mintedNft,
    isMinting,
    startMint,
    resetFlow,
    checkEligibility,
  } = useNftMint();

  // Gallery state
  const [nfts, setNfts] = useState<NftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Tabs & filters
  const [viewTab, setViewTab] = useState<ViewTab>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

  // Stats
  const [totalNfts, setTotalNfts] = useState(0);
  const [claimedCount, setClaimedCount] = useState(0);

  // Modals
  const [showEligibilityModal, setShowEligibilityModal] = useState(false);
  const showRevealModal = flowState === "revealing";
  const [ensuringChatAccess, setEnsuringChatAccess] = useState(false);

  // Debounce search
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Fetch all NFTs (no pagination - show all 100)
  const fetchNfts = useCallback(async () => {
    setLoading(true);
    setError(null);

    const params = new URLSearchParams({
      limit: "100",
      sort: "tokenId",
      order: "asc",
    });

    if (debouncedSearch.trim()) {
      params.set("search", debouncedSearch.trim());
    }

    const response = await fetch(
      apiUrl(`/api/nft/collection?${params.toString()}`),
    );

    if (!response.ok) {
      setError("Failed to load NFT collection");
      setLoading(false);
      return;
    }

    const data: NftGalleryResponse = await response.json();

    setNfts(data.data.nfts);
    setTotalNfts(data.data.stats.totalNfts);
    setClaimedCount(data.data.stats.claimedCount);
    setLoading(false);
  }, [debouncedSearch]);

  useEffect(() => {
    fetchNfts();
  }, [fetchNfts]);

  // Filter NFTs based on tab (match by user ID or wallet address)
  const isMyNft = (nft: NftSummary) => {
    if (!user) return false;
    if (nft.owner?.user?.id === user.id) return true;
    return false;
  };

  const displayedNfts = viewTab === "mine" ? nfts.filter(isMyNft) : nfts;
  const myNftCount = nfts.filter(isMyNft).length;

  // Handle claim button click
  const handleClaimClick = async () => {
    if (!authenticated) return;
    await checkEligibility();
    setShowEligibilityModal(true);
  };

  // Handle mint from eligibility modal
  const handleMintFromModal = async () => {
    setShowEligibilityModal(false);
    await startMint();
    fetchNfts();
  };

  const handleOpenGatedChat = async () => {
    if (!authenticated) return;
    if (myNftCount === 0) return;

    setEnsuringChatAccess(true);
    try {
      const response = await apiFetch("/api/nft/chat/ensure", {
        method: "POST",
      });

      if (!response.ok) {
        const json = (await response.json().catch(() => null)) as {
          error?: string;
        } | null;
        toast.error(json?.error ?? "Failed to unlock chat access");
        return;
      }

      router.push("/chats");
    } catch {
      toast.error("Failed to unlock chat access");
    } finally {
      setEnsuringChatAccess(false);
    }
  };

  const mintStepState = {
    preparing: flowState === "preparing",
    minting: flowState === "minting",
    confirming: flowState === "confirming",
  };

  const mintStepIndex = mintStepState.confirming
    ? 2
    : mintStepState.minting
      ? 1
      : 0;

  const mintStatusMessage = mintStepState.preparing
    ? "Preparing your claim..."
    : mintStepState.minting
      ? "Submitting transaction to Ethereum..."
      : "Waiting for network confirmation...";

  return (
    <PageContainer noPadding className="flex h-full flex-col pt-14 md:pt-0">
      {/* Header */}
      <div className="border-border border-b bg-card px-4 py-5">
        <div className="mx-auto max-w-5xl">
          <div className="mb-4 flex items-start justify-between">
            <div>
              <h1 className="mb-1 font-bold text-foreground text-xl">
                ProtoMonkeys
              </h1>
              <p className="text-muted-foreground text-sm">
                Exclusive NFTs for top 100 players
              </p>
            </div>

            {authenticated && myNftCount === 0 && !eligibility?.hasMinted && (
              <button
                onClick={handleClaimClick}
                disabled={isMinting || isCheckingEligibility}
                className="rounded-full bg-[#0066FF] px-5 py-2.5 font-semibold text-sm text-white shadow-md transition-all hover:scale-105 hover:bg-[#2952d9] hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
              >
                {isCheckingEligibility ? "Checking..." : "Claim"}
              </button>
            )}

            {authenticated && myNftCount > 0 && (
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleOpenGatedChat}
                  disabled={ensuringChatAccess}
                  className="rounded-lg border border-[#0066FF]/30 bg-[#0066FF]/10 px-4 py-2 text-[#0066FF] text-sm transition-colors hover:bg-[#0066FF]/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {ensuringChatAccess
                    ? "Opening chat..."
                    : "Open FD Alpha Chat →"}
                </button>
                {eligibility?.mintedNft ? (
                  <a
                    href={`/nft/${eligibility.mintedNft.tokenId}`}
                    className="rounded-lg border border-green-500/30 bg-green-500/10 px-4 py-2 text-green-600 text-sm transition-colors hover:bg-green-500/20"
                  >
                    View My NFT →
                  </a>
                ) : null}
              </div>
            )}
          </div>

          {/* Stats row */}
          <div className="flex items-center gap-6 text-sm">
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">{totalNfts}</span>{" "}
              Total
            </span>
            <span className="text-muted-foreground">
              <span className="font-medium text-green-600">{claimedCount}</span>{" "}
              Claimed
            </span>
            <span className="text-muted-foreground">
              <span className="font-medium text-foreground">
                {totalNfts - claimedCount}
              </span>{" "}
              Available
            </span>
          </div>
        </div>
      </div>

      {/* Tabs & Search */}
      <div className="border-border border-b px-4 py-3">
        <div className="mx-auto flex max-w-5xl items-center justify-between gap-4">
          {/* Tabs */}
          <div className="flex gap-1">
            <button
              onClick={() => setViewTab("all")}
              className={`rounded-md px-4 py-2 font-medium text-sm transition-colors ${
                viewTab === "all"
                  ? "bg-[#0066FF] text-white"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              }`}
            >
              <span className="sm:hidden">All</span>
              <span className="hidden sm:inline">All NFTs</span>
            </button>
            {authenticated && (
              <button
                onClick={() => setViewTab("mine")}
                className={`rounded-md px-4 py-2 font-medium text-sm transition-colors ${
                  viewTab === "mine"
                    ? "bg-[#0066FF] text-white"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground"
                }`}
              >
                <span className="sm:hidden">
                  Mine{myNftCount > 0 && ` (${myNftCount})`}
                </span>
                <span className="hidden sm:inline">
                  My NFT{myNftCount > 0 && ` (${myNftCount})`}
                </span>
              </button>
            )}
          </div>

          {/* Search */}
          <div className="relative w-64">
            <input
              type="text"
              placeholder="Search by name or #..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground text-sm placeholder:text-muted-foreground focus:border-[#0066FF] focus:outline-none"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                ×
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Error State */}
      {error && (
        <div className="flex flex-1 items-center justify-center p-8">
          <div className="text-center">
            <p className="mb-2 font-medium text-foreground">
              Failed to load collection
            </p>
            <p className="mb-4 text-muted-foreground text-sm">{error}</p>
            <button
              onClick={fetchNfts}
              className="rounded-full border border-border bg-transparent px-5 py-2.5 font-medium text-foreground text-sm transition-colors hover:bg-muted"
            >
              Try Again
            </button>
          </div>
        </div>
      )}

      {/* NFT Grid - Scrollable */}
      {!error && (
        <div className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-5xl">
            <NftGrid nfts={displayedNfts} isLoading={loading} />
          </div>
        </div>
      )}

      {/* Eligibility Modal */}
      {showEligibilityModal && (
        <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-xl border border-border bg-card p-6 shadow-xl">
            {isCheckingEligibility ? (
              <div className="py-8 text-center">
                <div className="mx-auto mb-4 h-8 w-8 animate-spin rounded-full border-2 border-[#0066FF] border-t-transparent" />
                <p className="text-muted-foreground">
                  Checking your eligibility...
                </p>
              </div>
            ) : eligibility?.eligible && !eligibility.hasMinted ? (
              <div className="text-center">
                <div className="mb-4 text-5xl">🎉</div>
                <h3 className="mb-2 font-bold text-foreground text-xl">
                  You&apos;re Eligible!
                </h3>
                <p className="mb-2 text-muted-foreground">
                  You ranked{" "}
                  <span className="font-bold text-[#0066FF]">
                    #{eligibility.snapshotRank}
                  </span>{" "}
                  on the leaderboard
                </p>
                <p className="mb-6 text-muted-foreground text-sm">
                  Claim your exclusive NFT from the ProtoMonkeys collection
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowEligibilityModal(false)}
                    className="flex-1 rounded-full border border-border bg-transparent py-2.5 font-medium text-foreground text-sm transition-colors hover:bg-muted"
                  >
                    Maybe Later
                  </button>
                  <button
                    onClick={handleMintFromModal}
                    disabled={isMinting}
                    className="flex-1 rounded-full bg-[#0066FF] py-2.5 font-semibold text-sm text-white shadow-md transition-all hover:scale-105 hover:bg-[#2952d9] hover:shadow-lg disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:scale-100"
                  >
                    {isMinting ? "Claiming..." : "Claim My NFT"}
                  </button>
                </div>
              </div>
            ) : eligibility?.hasMinted ? (
              <div className="text-center">
                <div className="mb-4 text-5xl">✅</div>
                <h3 className="mb-2 font-bold text-foreground text-xl">
                  Already Claimed
                </h3>
                <p className="mb-6 text-muted-foreground">
                  You&apos;ve already claimed your NFT!
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowEligibilityModal(false)}
                    className="flex-1 rounded-full border border-border bg-transparent py-2.5 font-medium text-foreground text-sm transition-colors hover:bg-muted"
                  >
                    Close
                  </button>
                  {eligibility.mintedNft && (
                    <a
                      href={`/nft/${eligibility.mintedNft.tokenId}`}
                      className="flex-1 rounded-full bg-[#0066FF] py-2.5 text-center font-semibold text-sm text-white shadow-md transition-all hover:scale-105 hover:bg-[#2952d9] hover:shadow-lg"
                    >
                      View My NFT
                    </a>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center">
                <div className="mb-4 text-5xl">😔</div>
                <h3 className="mb-2 font-bold text-foreground text-xl">
                  Not Eligible
                </h3>
                <p className="mb-6 text-muted-foreground">
                  Only the top 100 leaderboard players can claim an NFT. Keep
                  trading to climb the ranks!
                </p>
                <div className="flex gap-3">
                  <button
                    onClick={() => setShowEligibilityModal(false)}
                    className="flex-1 rounded-full border border-border bg-transparent py-2.5 font-medium text-foreground text-sm transition-colors hover:bg-muted"
                  >
                    Close
                  </button>
                  <a
                    href="/leaderboard"
                    className="flex-1 rounded-full bg-[#0066FF] py-2.5 text-center font-semibold text-sm text-white shadow-md transition-all hover:scale-105 hover:bg-[#2952d9] hover:shadow-lg"
                  >
                    View Leaderboard
                  </a>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Reveal Modal */}
      <RevealModal
        isOpen={showRevealModal}
        nft={mintedNft}
        onClose={resetFlow}
      />

      {/* Mint Loading Overlay */}
      {isMinting && (
        <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/70 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-2xl">
            <div className="mb-5 flex justify-center">
              <div className="relative h-16 w-16">
                <div className="absolute inset-0 animate-ping rounded-full bg-[#0066FF]/25" />
                <div className="absolute inset-0 animate-spin rounded-full border-2 border-[#0066FF]/20 border-t-[#0066FF]" />
                <div className="absolute inset-2 rounded-full bg-[#0066FF]/10" />
              </div>
            </div>

            <h3 className="mb-2 text-center font-bold text-foreground text-lg">
              Mint in progress
            </h3>
            <p className="mb-5 text-center text-muted-foreground text-sm">
              {mintStatusMessage}
            </p>

            <div className="mb-4 grid grid-cols-3 gap-2 text-center">
              {["Prepare", "Submit", "Confirm"].map((label, index) => {
                const isActive = index === mintStepIndex;
                const isComplete = index < mintStepIndex;

                return (
                  <div key={label} className="space-y-1">
                    <div
                      className={`h-1.5 rounded-full transition-colors ${
                        isComplete || isActive
                          ? "bg-[#0066FF]"
                          : "bg-muted-foreground/20"
                      }`}
                    />
                    <p
                      className={`font-medium text-xs ${
                        isComplete || isActive
                          ? "text-foreground"
                          : "text-muted-foreground"
                      }`}
                    >
                      {label}
                    </p>
                  </div>
                );
              })}
            </div>

            <p className="text-center text-muted-foreground/80 text-xs">
              This can take around 15-30 seconds on Ethereum mainnet.
            </p>
          </div>
        </div>
      )}
    </PageContainer>
  );
}
