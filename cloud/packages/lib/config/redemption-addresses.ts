/**
 * Known Exchange & Custodial Address Database
 *
 * Used to detect and warn users when they attempt to redeem tokens to
 * custodial wallets like exchanges. While not strictly blocked, users
 * should be warned that they may not receive tokens properly.
 *
 * IMPORTANT: This is not a complete list. Exchange addresses change frequently
 * and vary by chain. We maintain common hot wallets for major exchanges.
 *
 * Sources:
 * - Etherscan/Basescan labels
 * - Exchange documentation
 * - Community-maintained lists
 */

import type { SupportedNetwork } from "@/lib/services/eliza-token-price";

// ============================================================================
// KNOWN EXCHANGE ADDRESSES
// ============================================================================

/**
 * Known exchange hot wallet addresses by network.
 * These are frequently-used deposit addresses that may reject unexpected tokens.
 */
export const KNOWN_EXCHANGE_ADDRESSES: Record<SupportedNetwork, Record<string, string>> = {
  ethereum: {
    // Coinbase
    "0x71660c4005ba85c37ccec55d0c4493e66fe775d3": "Coinbase",
    "0x503828976d22510aad0201ac7ec88293211d23da": "Coinbase",
    "0xddfabcdc4d8ffc6d5beaf154f18b778f892a0740": "Coinbase",
    "0x3cd751e6b0078be393132286c442345e5dc49699": "Coinbase",
    "0xb5d85cbf7cb3ee0d56b3bb207d5fc4b82f43f511": "Coinbase",
    // Binance
    "0x3f5ce5fbfe3e9af3971dd833d26ba9b5c936f0be": "Binance",
    "0xd551234ae421e3bcba99a0da6d736074f22192ff": "Binance",
    "0x564286362092d8e7936f0549571a803b203aaced": "Binance",
    "0x0681d8db095565fe8a346fa0277bffde9c0edbbf": "Binance",
    "0xfe9e8709d3215310075d67e3ed32a380ccf451c8": "Binance",
    "0x4e9ce36e442e55ecd9025b9a6e0d88485d628a67": "Binance",
    // Kraken
    "0x2910543af39aba0cd09dbb2d50200b3e800a63d2": "Kraken",
    "0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13": "Kraken",
    "0xe853c56864a2ebe4576a807d26fdc4a0ada51919": "Kraken",
    // OKX
    "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX",
    "0x236f9f97e0e62388479bf9e5ba4889e46b0273c3": "OKX",
    // Gemini
    "0xd24400ae8bfebb18ca49be86258a3c749cf46853": "Gemini",
    "0x6fc82a5fe25a5cdb58bc74600a40a69c065263f8": "Gemini",
    // Bybit
    "0xf89d7b9c864f589bbf53a82105107622b35eaa40": "Bybit",
    // KuCoin
    "0xd6216fc19db775df9774a6e33526131da7d19a2c": "KuCoin",
    "0xf16e9b0d03470827a95cdfd0cb8a8a3b46969b91": "KuCoin",
  },
  base: {
    // Coinbase (Base)
    "0xcdac0d6c6c59727a65f871236188350531885c43": "Coinbase",
    "0x9858effd232b4033e47d90003d41ec34ecaeda94": "Coinbase",
    // Binance Bridge
    "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae": "Binance Bridge",
  },
  bnb: {
    // Binance (BNB Chain)
    "0x8894e0a0c962cb723c1976a4421c95949be2d4e3": "Binance",
    "0xe2fc31f816a9b94326492132018c3aecc4a93ae1": "Binance",
    "0x3c783c21a0383057d128bae431894a5c19f9cf06": "Binance",
    "0xf977814e90da44bfa03b6295a0616a897441acec": "Binance",
    // KuCoin
    "0x1692e170361cefd1eb7240ec13d048fd9af6d667": "KuCoin",
    // OKX
    "0x6cc5f688a315f3dc28a7781717a9a798a59fda7b": "OKX",
  },
  solana: {
    // Coinbase
    GJRs4FwHtemZ5ZE9x3FNvJ8TMwitKTh21yxdRPqn7npE: "Coinbase",
    H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS: "Coinbase",
    // Binance
    "5tzFkiKscXHK5ZXCGbXZxdw7gTjjD1mBwuoFbhUvuAi9": "Binance",
    "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM": "Binance",
    "2ojv9BAiHUrvsm9gxDe7fJSzbNZSJcxZvf8dqmWGHG8S": "Binance",
    // Kraken
    FWznbcNXWQuHTawe9RxvQ2LdCENssh12dsznf4RiouN5: "Kraken",
    // OKX
    "5VCwKtCXgCJ6kit5FybXjvriW3xELsFDhYrPSqtJNmcD": "OKX",
    // Bybit
    AC5RDfQFmDS1deWZos921JfqscXdByf8BKHs5ACWjtW2: "Bybit",
  },
};

// ============================================================================
// KNOWN CONTRACT PATTERNS
// ============================================================================

/**
 * Patterns that indicate multi-sig or smart contract wallets.
 * While some (like Safe) can receive tokens, users should be aware.
 */
export const SMART_WALLET_PATTERNS = {
  // Safe multi-sig prefix patterns (first bytes of deployed bytecode)
  safeProxy: "0x608060405234801561001057600080fd5b50",
  safeL2: "0x6080604052348015600f57600080fd5b50",
  // Argent wallet pattern
  argentProxy: "0x363d3d373d3d3d363d73",
};

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

export interface AddressCheckResult {
  isExchange: boolean;
  exchangeName?: string;
  isSmartWallet: boolean;
  warningMessage?: string;
  recommendation?: string;
}

/**
 * Check if an address is a known exchange or custodial wallet.
 */
export function checkKnownAddress(address: string, network: SupportedNetwork): AddressCheckResult {
  const normalizedAddress = address.toLowerCase();
  const networkAddresses = KNOWN_EXCHANGE_ADDRESSES[network];

  // Check exact match against known exchange addresses
  for (const [knownAddr, exchangeName] of Object.entries(networkAddresses)) {
    if (normalizedAddress === knownAddr.toLowerCase()) {
      return {
        isExchange: true,
        exchangeName,
        isSmartWallet: false,
        warningMessage: `This appears to be a ${exchangeName} deposit address.`,
        recommendation: getWalletRecommendation(network),
      };
    }
  }

  return {
    isExchange: false,
    isSmartWallet: false,
  };
}

/**
 * Get wallet recommendation based on network.
 */
export function getWalletRecommendation(network: SupportedNetwork): string {
  if (network === "solana") {
    return (
      "We recommend using a personal wallet like Phantom, Solflare, or Backpack. " +
      "Exchange deposit addresses may not credit unexpected tokens properly."
    );
  }

  if (network === "base") {
    return (
      "We recommend using a personal wallet like Coinbase Wallet (self-custody), " +
      "MetaMask, or Rainbow. Exchange deposit addresses may not credit unexpected tokens properly."
    );
  }

  return (
    "We recommend using a personal wallet like MetaMask, Rainbow, or Coinbase Wallet (self-custody). " +
    "Exchange deposit addresses may not credit unexpected tokens properly."
  );
}

/**
 * Get a formatted warning for non-EOA addresses.
 */
export function getNonEOAWarning(
  network: SupportedNetwork,
  isContract: boolean,
  exchangeInfo?: { name: string },
): string {
  if (exchangeInfo) {
    return (
      `⚠️ WARNING: This appears to be a ${exchangeInfo.name} exchange address.\n\n` +
      `Sending elizaOS tokens to exchange deposit addresses may result in lost funds. ` +
      `${exchangeInfo.name} may not support the elizaOS token.\n\n` +
      getWalletRecommendation(network)
    );
  }

  if (isContract) {
    return (
      `⚠️ WARNING: This appears to be a smart contract address.\n\n` +
      `Smart contracts may not be able to receive or transfer tokens. ` +
      `Please use an EOA (Externally Owned Account) - a regular wallet address.\n\n` +
      getWalletRecommendation(network)
    );
  }

  return "";
}

// ============================================================================
// VESTING CONFIGURATION
// ============================================================================

/**
 * Configuration for point vesting before redemption is allowed.
 * Points must be held for this duration before becoming redeemable.
 */
export const VESTING_CONFIG = {
  // Minimum time points must be held before redemption (24 hours)
  MIN_HOLD_PERIOD_MS: 24 * 60 * 60 * 1000,

  // For earnings from apps, hold period is longer (7 days)
  APP_EARNINGS_HOLD_PERIOD_MS: 7 * 24 * 60 * 60 * 1000,

  // For referral bonuses, hold period (14 days)
  REFERRAL_HOLD_PERIOD_MS: 14 * 24 * 60 * 60 * 1000,

  // Release pending to withdrawable at this time each day (UTC)
  DAILY_RELEASE_HOUR_UTC: 0, // Midnight UTC

  // Maximum percentage of balance redeemable per day (anti-fraud)
  MAX_DAILY_REDEMPTION_PERCENT: 0.5, // 50%
};

/**
 * Source types for earned points with their vesting periods.
 */
export const POINT_SOURCE_VESTING: Record<string, number> = {
  referral_signup_bonus: VESTING_CONFIG.REFERRAL_HOLD_PERIOD_MS,
  referral_qualified_bonus: VESTING_CONFIG.REFERRAL_HOLD_PERIOD_MS,
  referral_commission: VESTING_CONFIG.REFERRAL_HOLD_PERIOD_MS,
  social_share: VESTING_CONFIG.MIN_HOLD_PERIOD_MS,
  app_earnings: VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS,
  inference_markup: VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS,
  purchase_share: VESTING_CONFIG.APP_EARNINGS_HOLD_PERIOD_MS,
  direct_purchase: 0, // No vesting for purchased credits
};

// ============================================================================
// FRAUD DETECTION THRESHOLDS
// ============================================================================

/**
 * Thresholds for flagging potentially fraudulent redemption patterns.
 */
export const FRAUD_THRESHOLDS = {
  // Flag if user redeems within X hours of earning points
  FAST_REDEEM_HOURS: 1,

  // Flag if user redeems more than X% of their total ever earned
  HIGH_REDEMPTION_RATIO: 0.9,

  // Flag if same payout address used by multiple accounts
  SHARED_ADDRESS_MAX_USERS: 2,

  // Flag if user has X+ failed redemptions
  FAILED_REDEMPTION_FLAG: 3,

  // Flag if redemption happens right after a price drop
  PRICE_DROP_WINDOW_MINUTES: 30,
  PRICE_DROP_THRESHOLD: 0.05, // 5%
};
