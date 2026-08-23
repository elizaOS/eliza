/**
 * Keeps complete rejected model requests briefly in a private process-local
 * store while exposing only opaque, owner-authorized references to diagnostics.
 * Live entries are never evicted to make room: admission fails as one complete
 * unit when the bounded store cannot retain the request losslessly.
 */

import { createHash, randomUUID } from "node:crypto";
import { ElizaError } from "../errors";

const HANDLE_PATTERN =
	/^rejected_model_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface RejectedModelInputReceipt {
	reference?: string;
	sha256: string;
	utf8Bytes: number;
	expiresAt?: string;
	stored: boolean;
}

interface RejectedModelInputEntry {
	ownerAgentId: string;
	ownerConversationId?: string;
	serializedRequest: string;
	utf8Bytes: number;
	expiresAtMs: number;
}

export interface RejectedModelInputStoreOptions {
	maxEntries?: number;
	maxBytes?: number;
	maxEntryBytes?: number;
	ttlMs?: number;
	now?: () => number;
}

export class RejectedModelInputStore {
	private readonly entries = new Map<string, RejectedModelInputEntry>();
	private readonly maxEntries: number;
	private readonly maxBytes: number;
	private readonly maxEntryBytes: number;
	private readonly ttlMs: number;
	private readonly now: () => number;
	private retainedBytes = 0;

	constructor(options: RejectedModelInputStoreOptions = {}) {
		this.maxEntries = options.maxEntries ?? 32;
		this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024;
		this.maxEntryBytes = options.maxEntryBytes ?? 8 * 1024 * 1024;
		this.ttlMs = options.ttlMs ?? 15 * 60 * 1000;
		this.now = options.now ?? Date.now;
		for (const [label, value] of Object.entries({
			maxEntries: this.maxEntries,
			maxBytes: this.maxBytes,
			maxEntryBytes: this.maxEntryBytes,
			ttlMs: this.ttlMs,
		})) {
			if (!Number.isSafeInteger(value) || value <= 0) {
				throw new TypeError(`${label} must be a positive safe integer`);
			}
		}
	}

	private sweepExpired(nowMs: number): void {
		for (const [reference, entry] of this.entries) {
			if (entry.expiresAtMs > nowMs) continue;
			this.entries.delete(reference);
			this.retainedBytes -= entry.utf8Bytes;
		}
	}

	put(input: {
		ownerAgentId: string;
		ownerConversationId?: string;
		serializedRequest: string;
	}): RejectedModelInputReceipt {
		const bytes = Buffer.byteLength(input.serializedRequest, "utf8");
		const digest = createHash("sha256")
			.update(input.serializedRequest)
			.digest("hex");
		const nowMs = this.now();
		this.sweepExpired(nowMs);
		if (
			bytes > this.maxEntryBytes ||
			this.entries.size >= this.maxEntries ||
			this.retainedBytes + bytes > this.maxBytes
		) {
			return { sha256: digest, utf8Bytes: bytes, stored: false };
		}
		const reference = `rejected_model_${randomUUID()}`;
		const expiresAtMs = nowMs + this.ttlMs;
		this.entries.set(reference, {
			ownerAgentId: input.ownerAgentId,
			...(input.ownerConversationId
				? { ownerConversationId: input.ownerConversationId }
				: {}),
			serializedRequest: input.serializedRequest,
			utf8Bytes: bytes,
			expiresAtMs,
		});
		this.retainedBytes += bytes;
		return {
			reference,
			sha256: digest,
			utf8Bytes: bytes,
			expiresAt: new Date(expiresAtMs).toISOString(),
			stored: true,
		};
	}

	read(input: {
		reference: string;
		requesterAgentId: string;
		requesterConversationId?: string;
	}): string {
		if (!HANDLE_PATTERN.test(input.reference)) {
			throw new ElizaError("Rejected model-input reference is invalid", {
				code: "REJECTED_MODEL_INPUT_INVALID_REFERENCE",
			});
		}
		const nowMs = this.now();
		const entry = this.entries.get(input.reference);
		if (!entry) {
			throw new ElizaError("Rejected model input is unavailable", {
				code: "REJECTED_MODEL_INPUT_UNAVAILABLE",
			});
		}
		if (entry.expiresAtMs <= nowMs) {
			this.entries.delete(input.reference);
			this.retainedBytes -= entry.utf8Bytes;
			throw new ElizaError("Rejected model input has expired", {
				code: "REJECTED_MODEL_INPUT_EXPIRED",
			});
		}
		if (
			entry.ownerAgentId !== input.requesterAgentId ||
			(entry.ownerConversationId !== undefined &&
				entry.ownerConversationId !== input.requesterConversationId)
		) {
			throw new ElizaError("Rejected model input is forbidden", {
				code: "REJECTED_MODEL_INPUT_FORBIDDEN",
			});
		}
		return entry.serializedRequest;
	}
}

export const rejectedModelInputStore = new RejectedModelInputStore();
