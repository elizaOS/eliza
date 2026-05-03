import { useState } from "react";
import { useWallet } from "../hooks/useWallet.js";
import { useStewardContext } from "../provider.js";
import type { WalletOverviewProps } from "../types.js";
import {
  copyToClipboard,
  formatBalance,
  getExplorerAddressUrl,
  truncateAddress,
} from "../utils/format.js";

/**
 * Displays agent wallet address, balances, chain info, and optional funding QR.
 */
export function WalletOverview({
  chains,
  showQR,
  showCopy = true,
  className,
  onCopyAddress,
}: WalletOverviewProps) {
  const { features } = useStewardContext();
  const { agent, balance, addresses, isLoading, error } = useWallet();
  const [copied, setCopied] = useState<string | null>(null);

  const shouldShowQR = showQR ?? features.showFundingQR;

  const handleCopy = async (address: string, chain: string) => {
    const ok = await copyToClipboard(address);
    if (ok) {
      setCopied(address);
      setTimeout(() => setCopied(null), 2000);
      onCopyAddress?.(address, chain as "evm" | "solana");
    }
  };

  if (isLoading) {
    return (
      <div className={`stwd-card stwd-wallet-overview ${className || ""}`}>
        <div className="stwd-loading">Loading wallet...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={`stwd-card stwd-wallet-overview ${className || ""}`}>
        <div className="stwd-error-text">Failed to load wallet: {error.message}</div>
      </div>
    );
  }

  if (!agent) return null;

  // Filter addresses by requested chains
  const displayAddresses = addresses.filter(
    (a) => !chains || chains.includes(a.chainFamily as "evm" | "solana"),
  );

  // Fallback to agent.walletAddress if no addresses endpoint
  if (displayAddresses.length === 0 && agent.walletAddress) {
    displayAddresses.push({ chainFamily: "evm", address: agent.walletAddress });
  }

  return (
    <div className={`stwd-card stwd-wallet-overview ${className || ""}`}>
      <div className="stwd-wallet-header">
        <h3 className="stwd-heading">{agent.name}</h3>
        {agent.platformId && (
          <span className="stwd-badge stwd-badge-muted">{agent.platformId}</span>
        )}
      </div>

      <div className="stwd-wallet-addresses">
        {displayAddresses.map((addr) => (
          <div key={addr.chainFamily} className="stwd-address-row">
            <span className="stwd-chain-badge">{addr.chainFamily.toUpperCase()}</span>
            <code className="stwd-address">{truncateAddress(addr.address)}</code>
            {showCopy && (
              <button
                className="stwd-btn stwd-btn-ghost stwd-btn-sm"
                onClick={() => handleCopy(addr.address, addr.chainFamily)}
                title="Copy address"
              >
                {copied === addr.address ? "✓" : "📋"}
              </button>
            )}
            <a
              className="stwd-link stwd-btn-sm"
              href={getExplorerAddressUrl(addr.address, 8453)}
              target="_blank"
              rel="noopener noreferrer"
              title="View on explorer"
            >
              ↗
            </a>
          </div>
        ))}
      </div>

      {balance && (
        <div className="stwd-wallet-balance">
          <div className="stwd-balance-label">Balance</div>
          <div className="stwd-balance-value">
            {balance.balances.nativeFormatted
              ? `${balance.balances.nativeFormatted} ${balance.balances.symbol}`
              : formatBalance(balance.balances.native, balance.balances.symbol)}
          </div>
          <div className="stwd-balance-chain">Chain ID: {balance.balances.chainId}</div>
        </div>
      )}

      {shouldShowQR && displayAddresses.length > 0 && (
        <div className="stwd-wallet-qr">
          <div className="stwd-qr-placeholder">
            <div className="stwd-qr-label">Fund this wallet</div>
            <code className="stwd-address-full">{displayAddresses[0].address}</code>
            <div className="stwd-muted-text">
              Send funds to the address above to fund this agent's wallet.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
