/**
 * MnemoPay Plugin Types
 *
 * Type definitions for the MnemoPay economic memory plugin.
 */

export interface MnemoPayMemoryEntry {
	content: string;
	importance: number;
	tags: string[];
	timestamp: number;
}

export interface MnemoPayTransaction {
	id: string;
	amount: number;
	description: string;
	status: "pending" | "settled" | "refunded";
	createdAt: number;
	settledAt?: number;
	refundedAt?: number;
}

export interface MnemoPayBalance {
	wallet: number;
	reputation: number;
}

export interface MnemoPayConfig {
	agentId: string;
	reputationDelta: number;
}

export type MnemoPayServiceTypeName = "mnemopay";
