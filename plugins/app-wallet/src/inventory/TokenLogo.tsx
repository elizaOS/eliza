import { useState } from "react";
import { getContractLogoUrl, getNativeLogoUrl } from "./chainConfig.ts";
import { chainIcon } from "./constants.ts";
import { normalizeInventoryImageUrl } from "./media-url.ts";

export function tokenLogoUrl(
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
      <img
        src={url}
        alt={symbol}
        width={size}
        height={size}
        className="inline-flex shrink-0 items-center justify-center rounded-full object-cover font-mono font-bold text-white"
        style={{ width: size, height: size }}
        onError={() => setErrored(true)}
      />
    );
  }
  return (
    <span
      className={`inline-flex items-center justify-center shrink-0 rounded-full font-mono font-bold bg-bg-muted ${icon.cls}`}
      style={{ width: size, height: size, fontSize: size * 0.38 }}
    >
      {symbol.charAt(0).toUpperCase()}
    </span>
  );
}
