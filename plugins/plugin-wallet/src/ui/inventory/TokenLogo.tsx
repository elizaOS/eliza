/**
 * `<TokenLogo>` renders a token's logo image, preferring `preferredLogoUrl`
 * over the chain's native/contract CDN lookup, and falling back to a
 * chain's default logo when the preferred image fails, then a neutral
 * monogram badge when neither image can be loaded.
 */

import { Avatar, AvatarFallback, AvatarImage } from "@elizaos/ui";
import * as React from "react";
import { useState } from "react";
import { getContractLogoUrl, getNativeLogoUrl } from "./chainConfig.ts";
import { chainIcon } from "./constants.ts";
import { normalizeInventoryImageUrl } from "./media-url.ts";

// The app's workspace-source build can emit classic JSX for plugin modules.
void React;

function tokenLogoUrl(
  chain: string,
  contractAddress: string | null,
): string | null {
  if (!contractAddress) {
    return getNativeLogoUrl(chain);
  }
  return getContractLogoUrl(chain, contractAddress);
}

export function TokenLogo({
  symbol,
  chain,
  contractAddress,
  preferredLogoUrl = null,
  size = 32,
}: {
  symbol: string;
  chain: string;
  contractAddress: string | null;
  preferredLogoUrl?: string | null;
  size?: number;
}) {
  const preferredResolved = normalizeInventoryImageUrl(preferredLogoUrl);
  const defaultResolved = normalizeInventoryImageUrl(
    tokenLogoUrl(chain, contractAddress),
  );
  return (
    <TokenLogoImage
      key={JSON.stringify([preferredResolved, defaultResolved])}
      symbol={symbol}
      chain={chain}
      size={size}
      preferredResolved={preferredResolved}
      defaultResolved={defaultResolved}
    />
  );
}

/** URL changes start a new attempt; each candidate fails at most once. */
function TokenLogoImage({
  symbol,
  chain,
  size,
  preferredResolved,
  defaultResolved,
}: {
  symbol: string;
  chain: string;
  size: number;
  preferredResolved: string | null;
  defaultResolved: string | null;
}) {
  const [failedUrls, setFailedUrls] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const url = [preferredResolved, defaultResolved].find(
    (candidate): candidate is string =>
      candidate !== null && !failedUrls.has(candidate),
  );
  const icon = chainIcon(chain);
  const monogram = symbol.trim().slice(0, 2).toUpperCase() || icon.code;

  if (url) {
    return (
      <Avatar presentation="walletLogo" size={size}>
        <AvatarImage
          src={url}
          alt={symbol}
          onLoadingStatusChange={(status) => {
            if (status === "error") {
              setFailedUrls((previous) => new Set([...previous, url]));
            }
          }}
        />
        <AvatarFallback tone={icon.tone} style={{ fontSize: size * 0.38 }}>
          {monogram}
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <Avatar
      presentation="walletLogo"
      size={size}
      role="img"
      aria-label={`${symbol} token`}
    >
      <AvatarFallback tone={icon.tone} style={{ fontSize: size * 0.38 }}>
        {monogram}
      </AvatarFallback>
    </Avatar>
  );
}
