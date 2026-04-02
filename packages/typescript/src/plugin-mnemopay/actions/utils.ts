/**
 * Shared utilities for MnemoPay actions.
 */

/**
 * Extract a transaction ID (tx_...) from message text.
 * Returns null if no transaction ID is found.
 */
export function extractTransactionId(text: string): string | null {
	const match = text.match(/tx_[a-zA-Z0-9_]+/);
	return match ? match[0] : null;
}
