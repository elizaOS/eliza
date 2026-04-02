/**
 * MnemoPay Service
 *
 * Manages the MnemoPayLite instance lifecycle. Initializes the economic
 * memory engine and exposes it to other plugin components via runtime.getService().
 *
 * In production, this wraps @mnemopay/sdk's MnemoPayLite. For environments
 * where the SDK is not installed, a built-in lite implementation is used
 * that provides the same core API surface.
 */

import { logger } from "../../logger.ts";
import {
	type IAgentRuntime,
	Service,
	type ServiceTypeName,
} from "../../types/index.ts";
import type {
	MnemoPayBalance,
	MnemoPayMemoryEntry,
	MnemoPayTransaction,
} from "../types.ts";

/**
 * Built-in lightweight MnemoPay engine.
 *
 * Mirrors the core API of @mnemopay/sdk's MnemoPayLite so the plugin
 * works out-of-the-box without requiring the external package.
 * If @mnemopay/sdk is installed, consumers can swap this for the real SDK.
 */
class MnemoPayLiteEngine {
	private agentId: string;
	private reputationDelta: number;
	private walletBalance: number;
	private reputation: number;
	private memories: MnemoPayMemoryEntry[];
	private transactions: Map<string, MnemoPayTransaction>;
	private txCounter: number;
	private listeners: Map<string, Array<(data: unknown) => void>>;

	constructor(agentId: string, reputationDelta = 0.05) {
		this.agentId = agentId;
		this.reputationDelta = reputationDelta;
		this.walletBalance = 0;
		this.reputation = 1.0;
		this.memories = [];
		this.transactions = new Map();
		this.txCounter = 0;
		this.listeners = new Map();
	}

	getAgentId(): string {
		return this.agentId;
	}

	on(event: string, listener: (data: unknown) => void): void {
		const existing = this.listeners.get(event) ?? [];
		existing.push(listener);
		this.listeners.set(event, existing);
	}

	private emit(event: string, data: unknown): void {
		const listeners = this.listeners.get(event) ?? [];
		for (const listener of listeners) {
			try {
				listener(data);
			} catch {
				// Swallow listener errors to prevent cascading failures
			}
		}
	}

	async remember(
		content: string,
		options: { importance?: number; tags?: string[] } = {},
	): Promise<MnemoPayMemoryEntry> {
		const entry: MnemoPayMemoryEntry = {
			content,
			importance: options.importance ?? 0.5,
			tags: options.tags ?? [],
			timestamp: Date.now(),
		};
		this.memories.push(entry);
		this.emit("memory:stored", entry);
		return entry;
	}

	async recall(query: string, limit = 5): Promise<MnemoPayMemoryEntry[]> {
		const queryLower = query.toLowerCase();
		const scored = this.memories
			.map((m) => {
				const contentMatch = m.content.toLowerCase().includes(queryLower)
					? 1
					: 0;
				const tagMatch = m.tags.some((t) =>
					t.toLowerCase().includes(queryLower),
				)
					? 0.5
					: 0;
				return { memory: m, score: contentMatch + tagMatch + m.importance };
			})
			.sort((a, b) => b.score - a.score)
			.slice(0, limit);

		const results = scored.map((s) => s.memory);
		this.emit("memory:recalled", { query, count: results.length });
		return results;
	}

	async charge(amount: number, description: string): Promise<string> {
		this.txCounter += 1;
		const txId = `tx_${this.agentId}_${this.txCounter}_${Date.now()}`;
		const tx: MnemoPayTransaction = {
			id: txId,
			amount,
			description,
			status: "pending",
			createdAt: Date.now(),
		};
		this.transactions.set(txId, tx);
		this.walletBalance -= amount;
		this.emit("payment:completed", tx);
		return txId;
	}

	async settle(txId: string): Promise<MnemoPayTransaction> {
		const tx = this.transactions.get(txId);
		if (!tx) {
			throw new Error(`Transaction ${txId} not found`);
		}
		if (tx.status !== "pending") {
			throw new Error(`Transaction ${txId} is already ${tx.status}`);
		}
		tx.status = "settled";
		tx.settledAt = Date.now();
		this.reputation = Math.min(2.0, this.reputation + this.reputationDelta);
		this.emit("reputation:changed", {
			reputation: this.reputation,
			delta: this.reputationDelta,
			reason: "settlement",
		});
		return tx;
	}

	async refund(txId: string): Promise<MnemoPayTransaction> {
		const tx = this.transactions.get(txId);
		if (!tx) {
			throw new Error(`Transaction ${txId} not found`);
		}
		if (tx.status !== "pending" && tx.status !== "settled") {
			throw new Error(`Transaction ${txId} cannot be refunded (${tx.status})`);
		}
		tx.status = "refunded";
		tx.refundedAt = Date.now();
		this.walletBalance += tx.amount;
		this.reputation = Math.max(0, this.reputation - this.reputationDelta);
		this.emit("payment:refunded", tx);
		this.emit("reputation:changed", {
			reputation: this.reputation,
			delta: -this.reputationDelta,
			reason: "refund",
		});
		return tx;
	}

	balance(): MnemoPayBalance {
		return {
			wallet: this.walletBalance,
			reputation: this.reputation,
		};
	}

	getTransaction(txId: string): MnemoPayTransaction | undefined {
		return this.transactions.get(txId);
	}

	getRecentTransactions(limit = 10): MnemoPayTransaction[] {
		return Array.from(this.transactions.values())
			.sort((a, b) => b.createdAt - a.createdAt)
			.slice(0, limit);
	}
}

export class MnemoPayService extends Service {
	static serviceType: ServiceTypeName = "mnemopay" as ServiceTypeName;

	private engine!: MnemoPayLiteEngine;

	capabilityDescription =
		"Economic memory for AI agents — tracks payments, reputation, and financial interaction outcomes";

	constructor(runtime?: IAgentRuntime) {
		super(runtime);
	}

	static async start(runtime: IAgentRuntime): Promise<Service> {
		const service = new MnemoPayService(runtime);
		await service.initialize(runtime);
		return service;
	}

	async stop(): Promise<void> {
		logger.info({ src: "service:mnemopay" }, "MnemoPayService stopped");
	}

	async initialize(runtime: IAgentRuntime): Promise<void> {
		this.runtime = runtime;

		const agentId =
			(runtime.getSetting("MNEMOPAY_AGENT_ID") as string) ??
			runtime.agentId;
		const reputationDelta = Number.parseFloat(
			(runtime.getSetting("MNEMOPAY_REPUTATION_DELTA") as string) ?? "0.05",
		);

		this.engine = new MnemoPayLiteEngine(agentId, reputationDelta);

		// Wire SDK events to Eliza logger
		this.engine.on("memory:stored", (data) => {
			logger.debug(
				{ src: "service:mnemopay", data },
				"Economic memory stored",
			);
		});
		this.engine.on("payment:completed", (data) => {
			logger.info(
				{ src: "service:mnemopay", data },
				"Payment charged",
			);
		});
		this.engine.on("reputation:changed", (data) => {
			logger.info(
				{ src: "service:mnemopay", data },
				"Reputation changed",
			);
		});

		logger.info(
			{
				src: "service:mnemopay",
				agentId,
				reputationDelta,
			},
			"MnemoPayService initialized",
		);
	}

	getEngine(): MnemoPayLiteEngine {
		return this.engine;
	}
}
