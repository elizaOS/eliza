"use client";

import { Sparkles, Trophy, Wallet } from "lucide-react";
import Image from "next/image";
import Link from "next/link";
import { Skeleton } from "@/components/shared/Skeleton";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { useNftMint } from "@/hooks/useNftMint";

interface MintBannerProps {
  onMintClick?: () => void;
}

export function MintBanner({ onMintClick }: MintBannerProps) {
  const { authenticated, ready } = useAuth();
  const { eligibility, isCheckingEligibility, isMinting, startMint } =
    useNftMint();

  const loading = !ready || isCheckingEligibility;

  const handleMintClick = () => {
    onMintClick?.() ?? startMint();
  };

  // Not authenticated
  if (!authenticated) {
    return (
      <div className="border-border border-b bg-gradient-to-r from-[#0066FF]/10 via-purple-500/10 to-[#0066FF]/10 p-6">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-4 flex items-center justify-center gap-2">
            <Sparkles className="h-6 w-6 text-[#0066FF]" />
            <h2 className="font-bold text-foreground text-xl">
              Feed Top 100 NFT Collection
            </h2>
          </div>
          <p className="mb-4 text-muted-foreground">
            Connect your account to see if you&apos;re eligible to mint an
            exclusive NFT
          </p>
          <Button variant="default" size="lg" disabled>
            <Wallet className="mr-2 h-5 w-5" />
            Connect to Check Eligibility
          </Button>
        </div>
      </div>
    );
  }

  // Loading
  if (loading) {
    return (
      <div className="border-border border-b bg-gradient-to-r from-[#0066FF]/10 via-purple-500/10 to-[#0066FF]/10 p-6">
        <div className="mx-auto max-w-4xl text-center">
          <Skeleton className="mx-auto mb-4 h-8 w-64" />
          <Skeleton className="mx-auto mb-4 h-4 w-96" />
          <Skeleton className="mx-auto h-12 w-48" />
        </div>
      </div>
    );
  }

  // Not eligible
  if (!eligibility?.eligible) {
    return (
      <div className="border-border border-b bg-gradient-to-r from-muted/50 to-muted/30 p-6">
        <div className="mx-auto max-w-4xl text-center">
          <div className="mb-4 flex items-center justify-center gap-2">
            <Trophy className="h-6 w-6 text-muted-foreground" />
            <h2 className="font-bold text-foreground text-xl">
              Feed Top 100 NFT Collection
            </h2>
          </div>
          <p className="mb-2 text-muted-foreground">
            Only the Top 100 leaderboard players are eligible to mint
          </p>
          <p className="text-muted-foreground text-sm">
            Keep trading and climbing the leaderboard for future drops!
          </p>
          <Link href="/leaderboard" className="mt-4 inline-block">
            <Button variant="outline" size="sm">
              View Leaderboard
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // Already minted
  if (eligibility.hasMinted && eligibility.mintedNft) {
    return (
      <div className="border-border border-b bg-gradient-to-r from-green-500/10 via-emerald-500/10 to-green-500/10 p-6">
        <div className="mx-auto flex max-w-4xl flex-col items-center gap-4 sm:flex-row">
          {/* NFT Thumbnail */}
          <div className="relative h-24 w-24 overflow-hidden rounded-xl border-2 border-green-500/50 shadow-green-500/20 shadow-lg">
            <Image
              src={eligibility.mintedNft.thumbnailUrl}
              alt={eligibility.mintedNft.name}
              fill
              className="object-cover"
            />
          </div>

          {/* Info */}
          <div className="flex-1 text-center sm:text-left">
            <div className="mb-1 flex items-center justify-center gap-2 sm:justify-start">
              <span className="text-2xl">✨</span>
              <h2 className="font-bold text-foreground text-xl">
                You Own an NFT!
              </h2>
            </div>
            <p className="mb-2 text-foreground">
              <span className="font-semibold">
                {eligibility.mintedNft.name}
              </span>
            </p>
            <p className="text-muted-foreground text-sm">
              Ranked #{eligibility.snapshotRank} at snapshot
            </p>
          </div>

          {/* Action */}
          <Link href={`/nft/${eligibility.mintedNft.tokenId}`}>
            <Button variant="outline" size="lg">
              View Your NFT
            </Button>
          </Link>
        </div>
      </div>
    );
  }

  // Eligible to mint
  return (
    <div className="border-border border-b bg-gradient-to-r from-[#0066FF]/20 via-purple-500/20 to-[#0066FF]/20 p-6">
      <div className="mx-auto max-w-4xl text-center">
        <div className="mb-4 flex items-center justify-center gap-2">
          <span className="text-3xl">🎉</span>
          <h2 className="font-bold text-2xl text-foreground">
            Congratulations!
          </h2>
        </div>

        <p className="mb-2 text-foreground text-lg">
          You ranked{" "}
          <span className="font-bold text-[#0066FF]">
            #{eligibility.snapshotRank}
          </span>{" "}
          in the Feed Leaderboard!
        </p>

        <p className="mb-6 text-muted-foreground">
          You&apos;re eligible to mint an exclusive NFT from the Top 100
          collection
        </p>

        <Button
          variant="default"
          size="lg"
          onClick={handleMintClick}
          disabled={isMinting}
          className="min-w-[200px] bg-gradient-to-r from-[#0066FF] to-purple-500 hover:from-[#0055DD] hover:to-purple-600"
        >
          {isMinting ? (
            <>
              <span className="mr-2 h-5 w-5 animate-spin rounded-full border-2 border-white border-t-transparent" />
              Minting...
            </>
          ) : (
            <>
              <Sparkles className="mr-2 h-5 w-5" />
              Mint Your NFT
            </>
          )}
        </Button>

        <p className="mt-4 text-muted-foreground text-xs">
          ⚡ Random assignment • One per wallet • Free mint (gas only)
        </p>
      </div>
    </div>
  );
}
