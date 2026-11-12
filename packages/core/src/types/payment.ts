/**
 * x402 paid-route types: the built-in network/asset presets, a route's price
 * declaration, and the pre-payment validation result.
 */

/** Built-in x402 payment preset names shipped with @elizaos/agent */
export type BuiltInPaymentConfig =
	| "base_usdc"
	| "solana_usdc"
	| "polygon_usdc"
	| "bsc_usdc"
	| "base_elizaos"
	| "solana_elizaos"
	| "solana_degenai";

/**
 * x402 configuration for a paid route.
 */
export interface X402Config {
	priceInCents: number;
	paymentConfigs?: (BuiltInPaymentConfig | string)[];
}

/**
 * Pre-payment validation result (eliza-x402 compatible).
 */
export interface X402ValidationResult {
	valid: boolean;
	error?: {
		status: number;
		message: string;
		details?: unknown;
	};
}
