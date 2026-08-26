/**
 * `<TokenLogo>` renders a token's logo image, preferring `preferredLogoUrl`
 * over the chain's native/contract CDN lookup, and falling back to a
 * monogram badge (first letter of the symbol) on load failure or when no URL
 * resolves.
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
  const [errored, setErrored] = useState(false);
  const preferredResolved = normalizeInventoryImageUrl(preferredLogoUrl);
  const defaultResolved = normalizeInventoryImageUrl(
    tokenLogoUrl(chain, contractAddress),
  );
  const url = errored
    ? null
    : preferredResolved
      ? preferredResolved
      : defaultResolved;
  const icon = chainIcon(chain);

  if (url) {
    return (
      <Avatar presentation="walletLogo" size={size}>
        <AvatarImage src={url} alt={symbol} onError={() => setErrored(true)} />
        <AvatarFallback tone={icon.tone} style={{ fontSize: size * 0.38 }}>
          {symbol.charAt(0).toUpperCase()}
        </AvatarFallback>
      </Avatar>
    );
  }
  return (
    <Avatar presentation="walletLogo" size={size}>
      <AvatarFallback tone={icon.tone} style={{ fontSize: size * 0.38 }}>
        {symbol.charAt(0).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}
