/**
 * Crypto payment configuration and constants.
 */
import Decimal from "decimal.js";

/**
 * OxaPay merchant fee percentage (1.5%).
 * OxaPay deducts this fee from payments before reporting to merchant.
 * So: receivedAmount = userPaid * (1 - fee%)
 * To get what user paid: userPaid = receivedAmount / (1 - fee%)
 */
export const OXAPAY_FEE_PERCENT = new Decimal("1.5");

/**
 * Multiplier to convert received amount to what user actually paid.
 * userPaidAmount = receivedAmount / OXAPAY_FEE_MULTIPLIER
 */
export const OXAPAY_FEE_MULTIPLIER = new Decimal(1).minus(OXAPAY_FEE_PERCENT.dividedBy(100));

/**
 * Supported payment currencies for OxaPay.
 */
export const SUPPORTED_PAY_CURRENCIES = [
  "USDT",
  "USDC",
  "BTC",
  "ETH",
  "BNB",
  "TRX",
  "SOL",
] as const;

export type OxaPayCurrency = (typeof SUPPORTED_PAY_CURRENCIES)[number];

/**
 * Webhook security configuration.
 */
export const WEBHOOK_CONFIG = {
  /** Maximum age of a webhook before rejection (seconds) */
  MAX_AGE_SECONDS: 1800, // 30 minutes - matches OxaPay's webhook retry window
  /** Tolerance for clock skew (seconds into the future) */
  CLOCK_SKEW_TOLERANCE_SECONDS: 30,
  /** Retention period for processed webhook events (days) */
  RETENTION_DAYS: 30,
} as const;

/**
 * OxaPay webhook payload structure.
 * Supports both camelCase (invoice API) and snake_case (white-label API) formats.
 *
 * NOTE: We always credit the invoice USD amount from the API, not webhook values.
 * - Underpayments: Rejected by OxaPay (underPaidCover: 0)
 * - Overpayments: User's responsibility
 */
export interface OxaPayWebhookPayload {
  track_id?: string;
  trackId?: string;
  status: string;
  /** Native currency amount (may NOT be USD for volatile coins!) */
  amount?: number;
  /** Native currency amount user sent */
  pay_amount?: number;
  payAmount?: number;
  address?: string;
  txID?: string;
  date?: number | string;
  timestamp?: number | string;
  payCurrency?: string;
  network?: string;
  receivedAmount?: number;
  received_amount?: number;
}

/**
 * Normalize webhook payload to consistent format.
 * Note: We use invoice amount from API for crediting, not these webhook values.
 */
export function normalizeWebhookPayload(payload: OxaPayWebhookPayload): {
  trackId: string;
  status: string;
  amount?: number;
  payAmount?: number;
  txID?: string;
} {
  // Check for receivedAmount field (some OxaPay responses may include this)
  const receivedAmount = payload.receivedAmount || payload.received_amount;

  return {
    trackId: payload.trackId || payload.track_id || "",
    status: payload.status,
    // Prefer receivedAmount if available, otherwise use amount
    amount: receivedAmount ?? payload.amount,
    payAmount: payload.payAmount || payload.pay_amount,
    txID: payload.txID,
  };
}

export type OxaPayNetwork =
  | "ERC20"
  | "TRC20"
  | "BEP20"
  | "POLYGON"
  | "SOL"
  | "BASE"
  | "ARB"
  | "OP"
  | "AUTO";

export interface NetworkConfig {
  id: OxaPayNetwork;
  name: string;
  confirmations: number;
  /** Percentage tolerance for amount validation (e.g., 0.5 = 0.5%, 2.0 = 2%) */
  tolerancePercent: number;
  minAmount: Decimal;
  maxAmount: Decimal;
}

/**
 * Payment expiration time (30 minutes).
 */
export const PAYMENT_EXPIRATION_MS = 30 * 60 * 1000;

/**
 * Payment expiration time in seconds for OxaPay API
 */
export const PAYMENT_EXPIRATION_SECONDS = PAYMENT_EXPIRATION_MS / 1000;

/**
 * Minimum payment amount in USD ($1).
 */
export const MIN_PAYMENT_AMOUNT = new Decimal("1");

/**
 * Maximum payment amount in USD ($10,000).
 */
export const MAX_PAYMENT_AMOUNT = new Decimal("10000");

/**
 * Network-specific configurations
 */
export const NETWORK_CONFIGS: Record<OxaPayNetwork, NetworkConfig> = {
  ERC20: {
    id: "ERC20",
    name: "Ethereum",
    confirmations: 12,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  TRC20: {
    id: "TRC20",
    name: "Tron",
    confirmations: 19,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  BEP20: {
    id: "BEP20",
    name: "BNB Smart Chain",
    confirmations: 15,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  POLYGON: {
    id: "POLYGON",
    name: "Polygon",
    confirmations: 128,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  SOL: {
    id: "SOL",
    name: "Solana",
    confirmations: 32,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  BASE: {
    id: "BASE",
    name: "Base",
    confirmations: 10,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  ARB: {
    id: "ARB",
    name: "Arbitrum",
    confirmations: 10,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  OP: {
    id: "OP",
    name: "Optimism",
    confirmations: 10,
    tolerancePercent: 0.5,
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
  AUTO: {
    id: "AUTO",
    name: "Auto-selected Network",
    confirmations: 1,
    tolerancePercent: 2.0, // Higher tolerance for auto-selected payments due to potential fee variations
    minAmount: MIN_PAYMENT_AMOUNT,
    maxAmount: MAX_PAYMENT_AMOUNT,
  },
};

/**
 * Calculate tolerance threshold for a payment amount.
 * Uses percentage-based tolerance for consistency across all payment sizes.
 */
export function calculateTolerance(amount: Decimal, network: OxaPayNetwork): Decimal {
  const config = NETWORK_CONFIGS[network];
  const toleranceMultiplier = new Decimal(1).minus(
    new Decimal(config.tolerancePercent).dividedBy(100),
  );
  return amount.times(toleranceMultiplier);
}

/**
 * Validate that an amount is within acceptable range.
 */
export function validatePaymentAmount(amount: Decimal): {
  valid: boolean;
  error?: string;
} {
  if (amount.lessThan(MIN_PAYMENT_AMOUNT)) {
    return {
      valid: false,
      error: `Amount must be at least $${MIN_PAYMENT_AMOUNT.toString()}`,
    };
  }

  if (amount.greaterThan(MAX_PAYMENT_AMOUNT)) {
    return {
      valid: false,
      error: `Amount must not exceed $${MAX_PAYMENT_AMOUNT.toString()}`,
    };
  }

  return { valid: true };
}

/**
 * Validate that received amount meets the expected amount.
 * Underpayment is NOT accepted - user must pay at least the full expected amount.
 * Overpayment is accepted - user will receive credits for the full amount paid.
 */
export function validateReceivedAmount(
  received: Decimal,
  expected: Decimal,
  _network: OxaPayNetwork,
): { valid: boolean; threshold: Decimal } {
  // No tolerance - received must be >= expected (exact or overpayment only)
  return {
    valid: received.greaterThanOrEqualTo(expected),
    threshold: expected,
  };
}

/**
 * Get network configuration by ID.
 */
export function getNetworkConfig(network: OxaPayNetwork): NetworkConfig {
  const config = NETWORK_CONFIGS[network];
  if (!config) {
    throw new Error(`Unsupported network: ${network}`);
  }
  return config;
}

/**
 * Get all supported networks.
 */
export function getSupportedNetworks(): OxaPayNetwork[] {
  return Object.keys(NETWORK_CONFIGS) as OxaPayNetwork[];
}

/**
 * Parses a timestamp value that could be in seconds or milliseconds.
 * Converts to milliseconds for consistency.
 */
function parseTimestamp(value: number | string): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) return undefined;
  // If it looks like seconds (before year 2100), convert to milliseconds
  return parsed < 10000000000 ? parsed * 1000 : parsed;
}

/**
 * Extracts timestamp from webhook header or payload.
 * Returns undefined if no valid timestamp found.
 */
export function extractWebhookTimestamp(
  header: string | null,
  payload: OxaPayWebhookPayload,
): number | undefined {
  // Try header first
  if (header) {
    const parsed = parseTimestamp(header);
    if (parsed !== undefined) return parsed;
  }

  // Try payload.date
  if (payload.date !== undefined) {
    const parsed = parseTimestamp(payload.date);
    if (parsed !== undefined) return parsed;
  }

  // Try payload.timestamp
  if (payload.timestamp !== undefined) {
    const parsed = parseTimestamp(payload.timestamp);
    if (parsed !== undefined) return parsed;
  }

  return undefined;
}

/**
 * Validates a webhook timestamp against max age and clock skew tolerance.
 */
export function validateWebhookTimestamp(timestampMs: number | undefined): {
  isValid: boolean;
  timestamp?: Date;
  error?: string;
} {
  if (timestampMs === undefined) {
    // No timestamp - graceful degradation, rely on deduplication
    return { isValid: true, timestamp: undefined };
  }

  const now = Date.now();
  const webhookDate = new Date(timestampMs);
  const ageSeconds = (now - timestampMs) / 1000;

  if (ageSeconds > WEBHOOK_CONFIG.MAX_AGE_SECONDS) {
    return {
      isValid: false,
      timestamp: webhookDate,
      error: `Webhook is too old (${Math.round(ageSeconds)} seconds). Maximum age: ${WEBHOOK_CONFIG.MAX_AGE_SECONDS} seconds`,
    };
  }

  if (ageSeconds < -WEBHOOK_CONFIG.CLOCK_SKEW_TOLERANCE_SECONDS) {
    return {
      isValid: false,
      timestamp: webhookDate,
      error: `Webhook timestamp is ${Math.abs(Math.round(ageSeconds))} seconds in the future`,
    };
  }

  return { isValid: true, timestamp: webhookDate };
}
