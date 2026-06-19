"use client";

import type { NftSummary } from "@/types/nft";
import { NftCard } from "./NftCard";

const GRID_CLASS =
  "grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5";
const SKELETON_COUNT = 15;

interface NftGridProps {
  nfts: NftSummary[];
  isLoading?: boolean;
}

export function NftGrid({ nfts, isLoading = false }: NftGridProps) {
  if (isLoading) {
    return (
      <div className={GRID_CLASS}>
        {Array.from({ length: SKELETON_COUNT }, (_, i) => (
          <div
            key={i}
            className="overflow-hidden rounded-lg border border-border bg-card"
          >
            <div className="aspect-square w-full animate-pulse bg-muted" />
            <div className="p-2.5">
              <div className="mb-1.5 h-4 w-3/4 animate-pulse rounded bg-muted" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (nfts.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-16 text-center">
        <p className="mb-2 font-medium text-foreground">No NFTs Found</p>
        <p className="text-muted-foreground text-sm">
          No NFTs match your search.
        </p>
      </div>
    );
  }

  return (
    <div className={GRID_CLASS}>
      {nfts.map((nft, i) => (
        <NftCard key={nft.tokenId} nft={nft} priority={i < 10} />
      ))}
    </div>
  );
}
