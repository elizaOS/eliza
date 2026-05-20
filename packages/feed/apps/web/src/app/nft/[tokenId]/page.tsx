'use client';

import Image from 'next/image';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '@/components/shared/Avatar';
import { PageContainer } from '@/components/shared/PageContainer';
import { Skeleton } from '@/components/shared/Skeleton';
import type { NftDetail, NftDetailResponse } from '@/types/nft';
import { apiUrl } from '@/utils/api-url';

export default function NftDetailPage() {
  const params = useParams();
  const tokenId = params.tokenId as string;

  const [nft, setNft] = useState<NftDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [imageError, setImageError] = useState(false);

  const fetchNft = useCallback(async () => {
    setLoading(true);
    setError(null);

    const response = await fetch(apiUrl(`/api/nft/${tokenId}`));

    if (!response.ok) {
      if (response.status === 404) {
        setError('NFT not found');
      } else {
        setError('Failed to load NFT details');
      }
      setLoading(false);
      return;
    }

    const data: NftDetailResponse = await response.json();
    setNft(data.data);
    setLoading(false);
  }, [tokenId]);

  useEffect(() => {
    fetchNft();
  }, [fetchNft]);

  const handleCopy = async (text: string) => {
    await navigator.clipboard.writeText(text);
  };

  const handleShare = async () => {
    if (!nft) return;

    const url = `${window.location.origin}/nft/${nft.tokenId}`;

    if (navigator.share) {
      await navigator.share({ title: nft.name, url });
    } else {
      await navigator.clipboard.writeText(url);
    }
  };

  if (loading) {
    return (
      <PageContainer className="px-4 pb-8 sm:px-6">
        <div className="mb-4 sm:mb-6">
          <Skeleton className="h-6 w-20 sm:w-32" />
        </div>
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
          <Skeleton className="mx-auto aspect-square w-full max-w-md rounded-xl lg:max-w-none" />
          <div className="space-y-3 sm:space-y-4">
            <Skeleton className="h-7 w-3/4 sm:h-8" />
            <Skeleton className="h-14 w-full sm:h-16" />
            <Skeleton className="h-20 w-full sm:h-24" />
          </div>
        </div>
      </PageContainer>
    );
  }

  if (error || !nft) {
    return (
      <PageContainer className="flex items-center justify-center px-4 py-16 sm:px-6">
        <div className="text-center">
          <p className="mb-2 font-medium text-foreground text-lg sm:text-xl">
            {error ?? 'NFT not found'}
          </p>
          <p className="mb-6 text-muted-foreground text-sm sm:text-base">
            The NFT you&apos;re looking for doesn&apos;t exist.
          </p>
          <Link
            href="/nft"
            className="inline-block rounded-full bg-[#0066FF] px-5 py-2.5 font-semibold text-sm text-white shadow-md transition-all hover:scale-105 hover:bg-[#2952d9] hover:shadow-lg"
          >
            ← Back to Gallery
          </Link>
        </div>
      </PageContainer>
    );
  }

  const isMinted = !!nft.currentOwner;

  const ownerName =
    nft.currentOwner?.user?.displayName ??
    nft.currentOwner?.user?.username ??
    (nft.currentOwner
      ? `${nft.currentOwner.walletAddress.slice(0, 6)}...${nft.currentOwner.walletAddress.slice(-4)}`
      : null);

  return (
    <PageContainer className="px-4 pb-8 sm:px-6">
      {/* Header */}
      <div className="mb-4 flex items-center justify-between sm:mb-6">
        <Link
          href="/nft"
          className="text-muted-foreground text-sm hover:text-foreground"
        >
          ← Back
        </Link>
        <button
          onClick={handleShare}
          className="rounded-full border border-border px-3 py-1.5 text-muted-foreground text-sm transition-colors hover:bg-muted hover:text-foreground"
        >
          Share
        </button>
      </div>

      <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
        {/* Image */}
        <div className="relative mx-auto aspect-square w-full max-w-md overflow-hidden rounded-xl border border-border bg-muted lg:max-w-none">
          {isMinted && !imageError ? (
            <Image
              src={nft.imageUrl}
              alt={nft.name}
              fill
              className="object-cover"
              sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 40vw"
              priority
              onError={() => setImageError(true)}
            />
          ) : isMinted && imageError ? (
            <div className="flex h-full w-full items-center justify-center text-6xl">
              🖼️
            </div>
          ) : (
            /* Unminted: placeholder with reveal overlay */
            <>
              <Image
                src="/icon-1024.png"
                alt={`Feed #${nft.tokenId}`}
                fill
                className="object-cover"
                sizes="(max-width: 768px) 100vw, (max-width: 1024px) 50vw, 40vw"
                priority
              />
              <div className="absolute inset-0 flex items-center justify-center bg-black/50">
                <span className="rounded-md bg-black/60 px-4 py-2 text-center font-medium text-sm text-white leading-tight">
                  Will Reveal
                  <br />
                  When Minted
                </span>
              </div>
            </>
          )}

          <div className="absolute top-3 left-3 rounded bg-black/70 px-2 py-1 font-medium text-sm text-white">
            #{nft.tokenId}
          </div>

          {/* Claimed indicator */}
          {isMinted && (
            <div className="absolute top-3 right-3 rounded bg-green-500 px-2 py-1 font-medium text-sm text-white">
              ✓ Minted
            </div>
          )}
        </div>

        {/* Details */}
        <div className="space-y-4 sm:space-y-5">
          {/* Title & Description */}
          <div>
            <h1 className="mb-1 font-bold text-foreground text-xl sm:mb-2 sm:text-2xl">
              {isMinted
                ? nft.name.endsWith(`#${nft.tokenId}`)
                  ? nft.name
                  : `${nft.name} #${nft.tokenId}`
                : `ProtoMonkey #${nft.tokenId}`}
            </h1>
            {isMinted && nft.description ? (
              <p className="text-muted-foreground text-sm sm:text-base">
                {nft.description}
              </p>
            ) : !isMinted ? (
              <p className="text-muted-foreground/60 text-sm italic sm:text-base">
                This NFT has not been minted yet. The image and metadata will be
                revealed once it is claimed.
              </p>
            ) : null}
          </div>

          {/* Owner */}
          <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
            <p className="mb-2 text-muted-foreground text-xs uppercase">
              Owner
            </p>
            {nft.currentOwner ? (
              <div className="flex items-center gap-3">
                <Avatar
                  id={
                    nft.currentOwner.user?.id ?? nft.currentOwner.walletAddress
                  }
                  name={ownerName ?? 'Unknown'}
                  src={nft.currentOwner.user?.profileImageUrl ?? undefined}
                  size="md"
                />
                <div className="min-w-0 flex-1">
                  {nft.currentOwner.user ? (
                    <Link
                      href={`/profile/${nft.currentOwner.user.username ?? nft.currentOwner.user.id}`}
                      className="font-medium text-foreground hover:text-[#0066FF]"
                    >
                      @
                      {nft.currentOwner.user.username ??
                        nft.currentOwner.user.displayName}
                    </Link>
                  ) : (
                    <button
                      onClick={() =>
                        handleCopy(nft.currentOwner!.walletAddress)
                      }
                      className="font-mono text-foreground text-sm hover:text-[#0066FF]"
                    >
                      {ownerName}
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <p className="text-muted-foreground/60 italic">Not yet claimed</p>
            )}
          </div>

          {/* Story */}
          {nft.story.content && (
            <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
              <p className="mb-2 font-medium text-foreground text-sm sm:text-base">
                {nft.story.title ?? 'Story'}
              </p>
              <p className="whitespace-pre-wrap text-muted-foreground text-xs sm:text-sm">
                {nft.story.content}
              </p>
            </div>
          )}

          {/* Attributes */}
          {nft.attributes.length > 0 && (
            <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
              <p className="mb-2 text-muted-foreground text-xs uppercase sm:mb-3">
                Attributes
              </p>
              <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 sm:gap-2">
                {nft.attributes.map((attr, i) => (
                  <div
                    key={i}
                    className="rounded bg-muted/50 p-1.5 text-center sm:p-2"
                  >
                    <p className="text-[10px] text-muted-foreground sm:text-xs">
                      {attr.trait_type}
                    </p>
                    <p className="truncate font-medium text-foreground text-xs sm:text-sm">
                      {String(attr.value)}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Original Claim */}
          {nft.originalClaim && (
            <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
              <p className="mb-2 text-muted-foreground text-xs uppercase sm:mb-3">
                Original Claim
              </p>
              <div className="grid grid-cols-3 gap-2 text-center sm:gap-4">
                <div>
                  <p className="font-bold text-[#0066FF] text-base sm:text-lg">
                    #{nft.originalClaim.snapshotRank}
                  </p>
                  <p className="text-[10px] text-muted-foreground sm:text-xs">
                    Rank
                  </p>
                </div>
                <div>
                  <p className="font-bold text-base text-foreground sm:text-lg">
                    {nft.originalClaim.snapshotPoints?.toLocaleString() ?? '-'}
                  </p>
                  <p className="text-[10px] text-muted-foreground sm:text-xs">
                    Points
                  </p>
                </div>
                <div>
                  <p className="font-bold text-base text-foreground sm:text-lg">
                    {new Date(nft.originalClaim.claimedAt).toLocaleDateString(
                      'en-US',
                      { month: 'short', day: 'numeric' }
                    )}
                  </p>
                  <p className="text-[10px] text-muted-foreground sm:text-xs">
                    Date
                  </p>
                </div>
              </div>
            </div>
          )}

          {/* Contract Info */}
          <div className="rounded-lg border border-border bg-card p-3 sm:p-4">
            <p className="mb-2 text-muted-foreground text-xs uppercase sm:mb-3">
              Contract
            </p>
            <div className="space-y-1.5 text-xs sm:space-y-2 sm:text-sm">
              <div className="flex justify-between">
                <span className="text-muted-foreground">Address</span>
                <button
                  onClick={() => handleCopy(nft.contractAddress)}
                  className="font-mono text-foreground hover:text-[#0066FF]"
                >
                  {nft.contractAddress.slice(0, 6)}...
                  {nft.contractAddress.slice(-4)}
                </button>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Token ID</span>
                <span className="font-mono text-foreground">{nft.tokenId}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-muted-foreground">Chain</span>
                <span className="text-foreground">
                  {nft.chainId === 1 ? 'Ethereum' : `Chain ${nft.chainId}`}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </PageContainer>
  );
}
