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
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const preferredResolved = normalizeInventoryImageUrl(preferredLogoUrl);
  const defaultResolved = normalizeInventoryImageUrl(
    tokenLogoUrl(chain, contractAddress),
  );
  const url =
    preferredResolved && preferredResolved !== failedUrl
      ? preferredResolved
      : defaultResolved && defaultResolved !== failedUrl
        ? defaultResolved
        : null;
  const icon = chainIcon(chain);
  const monogram = symbol.trim().slice(0, 2).toUpperCase() || icon.code;

  if (url) {
    return (
      <Avatar presentation="walletLogo" size={size}>
        <AvatarImage src={url} alt={symbol} onError={() => setFailedUrl(url)} />
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
