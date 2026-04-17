import { useState } from "react";
import type { createTranslator } from "../../i18n";
import { chainIcon, type NftItem } from "./constants";
import { normalizeInventoryImageUrl } from "./media-url";

export interface NftGridProps {
  t: ReturnType<typeof createTranslator>;
  walletNftsLoading: boolean;
  walletNfts: unknown;
  allNfts: NftItem[];
}

export function NftGrid({
  t,
  walletNftsLoading,
  walletNfts,
  allNfts,
}: NftGridProps) {
  const [failedImages, setFailedImages] = useState<Set<string>>(new Set());

  if (walletNftsLoading) {
    return (
      <div className="flex min-h-[24rem] flex-1 items-center justify-center px-6 text-center text-sm text-muted">
        {t("wallet.loadingNfts")}
      </div>
    );
  }
  if (!walletNfts) {
    return (
      <div className="flex min-h-[24rem] flex-1 items-center justify-center px-6 text-center text-sm text-muted">
        {t("wallet.noNftData")}
      </div>
    );
  }
  if (allNfts.length === 0) {
    return (
      <div className="flex min-h-[24rem] flex-1 items-center justify-center px-6 text-center text-sm text-muted">
        {t("wallet.noNftsFound")}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-4 p-4 sm:p-5">
      {allNfts.map((nft, idx) => {
        const icon = chainIcon(nft.chain);
        const key = `${nft.chain}-${nft.name}-${idx}`;
        const normalizedImageUrl = normalizeInventoryImageUrl(nft.imageUrl);
        const showImage = Boolean(normalizedImageUrl) && !failedImages.has(key);
        return (
          <div
            key={key}
            className="overflow-hidden rounded-2xl border border-border/40 bg-card/88 shadow-sm transition-transform hover:-translate-y-0.5"
          >
            {showImage ? (
              <img
                src={normalizedImageUrl ?? ""}
                alt={nft.name}
                loading="lazy"
                className="block h-[180px] w-full bg-bg-muted object-cover"
                onError={() => {
                  setFailedImages((prev) => {
                    const next = new Set(prev);
                    next.add(key);
                    return next;
                  });
                }}
              />
            ) : (
              <div className="flex h-[180px] w-full items-center justify-center bg-bg-muted text-xs-tight text-muted">
                {t("wallet.noImage")}
              </div>
            )}
            <div className="px-3 py-3">
              <div className="truncate text-xs font-semibold text-txt-strong">
                {nft.name}
              </div>
              <div className="mt-1 truncate text-2xs text-muted">
                {nft.collectionName}
              </div>
              <div className="mt-2 inline-flex items-center gap-1 rounded-full border border-border/45 bg-bg/25 px-2 py-1 text-2xs text-muted">
                <span
                  className={`inline-block w-3 h-3 rounded-full text-center leading-3 text-3xs font-bold font-mono text-white ${icon.cls}`}
                >
                  {icon.code}
                </span>
                {nft.chain}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
