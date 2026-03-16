/**
 * Token logo with CDN image + letter-fallback.
 */

import { useState } from "react";
import { getContractLogoUrl, getNativeLogoUrl } from "../chainConfig";
import { chainIcon } from "./constants";
import { normalizeInventoryImageUrl } from "./media-url";

/* ── Logo URL resolver ──────────────────────────────────────────────── */

export function tokenLogoUrl(
  chain: string,
  contractAddress: string | null,
): string | null {
  if (!contractAddress) {
    // Use chain config for native logo resolution
    return getNativeLogoUrl(chain);
  }
  // Use chain config for contract logo resolution (TrustWallet CDN)
  return getContractLogoUrl(chain, contractAddress);
}

/* ── Component ──────────────────────────────────────────────────────── */

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
      <img
        src={url}
        alt={symbol}
        width={size}
        height={size}
        className="wt__token-logo"
        onError={() => setErrored(true)}
      />
    );
  }
  return (
    <span
      className={`wt__token-logo is-letter ${icon.cls}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {symbol.charAt(0).toUpperCase()}
    </span>
  );
}
