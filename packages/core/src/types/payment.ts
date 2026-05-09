import type { JsonObject } from "./primitives";

/**
 * Payment configuration definition for x402-enabled routes.
 */
export interface PaymentConfigDefinition {
	network: string;
	assetNamespace: string;
	assetReference: string;
	paymentAddress: string;
	symbol: string;
	chainId?: string;
}

/** Built-in x402 payment preset names shipped with @elizaos/agent */
export type BuiltInPaymentConfig =
	| "base_usdc"
	| "solana_usdc"
	| "polygon_usdc"
	| "base_elizaos"
	| "solana_elizaos"
	| "solana_degenai";

/**
 * Character-level defaults for paid routes (`x402: true` or partial `x402` on routes).
 * Set under `character.settings.x402`.
 */
export interface CharacterX402Settings {
	defaultPaymentConfigs?: (BuiltInPaymentConfig | string)[];
	defaultPriceInCents?: number;
}

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

export type X402RequestValidator = (
	req: import("./plugin").RouteRequest,
) => X402ValidationResult | Promise<X402ValidationResult>;

/**
 * x402 "accepts" entry describing payment terms.
 */
export interface X402Accepts {
	scheme: "exact";
	network: string;
	maxAmountRequired: string;
	resource: string;
	description: string;
	mimeType: string;
	payTo: string;
	maxTimeoutSeconds: number;
	asset: string;
	outputSchema?: JsonObject;
	extra?: JsonObject;
}

/**
 * x402 payment-required response payload.
 */
export interface X402Response {
	x402Version: number;
	error?: string;
	accepts?: X402Accepts[];
	payer?: string;
}
