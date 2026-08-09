/**
 * PairingService - Manages secure DM access via pairing codes.
 *
 * This service handles the pairing workflow for messaging channels:
 * 1. Unknown users send a DM and receive a pairing code
 * 2. Bot owner approves the code via CLI or API
 * 3. User is added to the allowlist and can now send DMs
 */

import {
	type ApprovePairingParams,
	type ApprovePairingResult,
	DEFAULT_PAIRING_CONFIG,
	normalizePairingPageOptions,
	PAIRING_CODE_ALPHABET,
	type PairingAllowlistEntry,
	type PairingChannel,
	type PairingConfig,
	type PairingPage,
	type PairingPageInfo,
	type PairingPageOptions,
	type PairingRequest,
	type UpsertPairingRequestParams,
	type UpsertPairingRequestResult,
} from "../types/pairing";
import type { IAgentRuntime } from "../types/runtime";
import { Service, ServiceType } from "../types/service";
import { stringToUuid } from "../utils";

/**
 * PairingService handles secure DM pairing for messaging channels.
 *
 * When a user sends a DM to a bot with dmPolicy="pairing":
 * 1. If not in allowlist, a pairing request is created with a code
 * 2. The code is sent back to the user
 * 3. The bot owner approves the code via CLI/API
 * 4. The user is added to the allowlist
 */
export class PairingService extends Service {
	static serviceType = ServiceType.PAIRING;
	capabilityDescription =
		"Manages secure DM access via pairing codes for messaging channels";

	private pairingConfig: Required<PairingConfig>;

	constructor(runtime: IAgentRuntime, config?: PairingConfig) {
		super(runtime);
		this.pairingConfig = {
			...DEFAULT_PAIRING_CONFIG,
			...config,
		};
	}

	/**
	 * Start the PairingService with the given runtime.
	 */
	static async start(runtime: IAgentRuntime): Promise<Service> {
		runtime.logger.info(
			{ src: "service:pairing", agentId: runtime.agentId },
			"Starting pairing service",
		);
		const service = new PairingService(runtime);
		return service;
	}

	/**
	 * Stop the PairingService.
	 */
	async stop(): Promise<void> {
		this.runtime.logger.info(
			{ src: "service:pairing", agentId: this.runtime.agentId },
			"Stopping pairing service",
		);
	}

	/**
	 * Generate a random pairing code.
	 * Uses a human-friendly alphabet that excludes ambiguous characters.
	 */
	private generateCode(): string {
		let code = "";
		for (let i = 0; i < this.pairingConfig.codeLength; i++) {
			const randomIndex = Math.floor(
				Math.random() * PAIRING_CODE_ALPHABET.length,
			);
			code += PAIRING_CODE_ALPHABET[randomIndex];
		}
		return code;
	}

	/**
	 * Generate a unique code that doesn't conflict with existing codes.
	 */
	private async generateUniqueCode(channel: PairingChannel): Promise<string> {
		const existingRequests = await this.listPendingRequests(channel);
		const existingCodes = new Set(
			existingRequests.map((r) => r.code.toUpperCase()),
		);

		for (let attempt = 0; attempt < 500; attempt++) {
			const code = this.generateCode();
			if (!existingCodes.has(code)) {
				return code;
			}
		}
		throw new Error(
			"Failed to generate unique pairing code after 500 attempts",
		);
	}

	/**
	 * Check if a pairing request is expired.
	 */
	private isExpired(request: PairingRequest): boolean {
		const createdAt =
			request.createdAt instanceof Date
				? request.createdAt.getTime()
				: new Date(request.createdAt).getTime();
		return Date.now() - createdAt > this.pairingConfig.requestTtlMs;
	}

	private requestExpiryCutoff(): Date {
		return new Date(Date.now() - this.pairingConfig.requestTtlMs);
	}

	private cleanupExpiredRequests(requests: PairingRequest[]): PairingRequest[] {
		const validRequests: PairingRequest[] = [];
		const expiredIds: PairingRequest["id"][] = [];

		for (const request of requests) {
			if (this.isExpired(request)) {
				expiredIds.push(request.id);
			} else {
				validRequests.push(request);
			}
		}

		if (expiredIds.length > 0) {
			Promise.all(
				expiredIds.map((id) => this.runtime.deletePairingRequest(id)),
			).catch((err) => {
				// error-policy:J6 Expired-row cleanup is best-effort maintenance; report
				// failures without hiding valid, unexpired pairing requests.
				this.runtime.reportError("PairingService.expiredCleanup", err, {
					requestCount: expiredIds.length,
				});
				this.runtime.logger.warn(
					{ src: "service:pairing", error: err },
					"Failed to clean up expired pairing requests",
				);
			});
		}

		return validRequests;
	}

	private newestFirst<T extends { createdAt: Date; id: PairingRequest["id"] }>(
		items: T[],
	): T[] {
		return [...items].sort((a, b) => {
			const timeDifference =
				new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
			if (timeDifference !== 0) {
				return timeDifference;
			}
			const aId = String(a.id);
			const bId = String(b.id);
			return aId === bId ? 0 : aId < bId ? 1 : -1;
		});
	}

	private pageInfo(
		limit: number,
		offset: number,
		hasMore: boolean,
	): PairingPageInfo {
		return {
			limit,
			offset,
			hasMore,
			nextOffset: hasMore ? offset + limit : null,
		};
	}

	/**
	 * List all pending pairing requests for a channel.
	 * Expired requests are automatically filtered out.
	 */
	async listPendingRequests(
		channel: PairingChannel,
	): Promise<PairingRequest[]> {
		const [result] = await this.runtime.getPairingRequests([
			{ channel, agentId: this.runtime.agentId },
		]);
		const validRequests = this.cleanupExpiredRequests(result.requests);

		return validRequests.sort(
			(a, b) =>
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);
	}

	/**
	 * List one bounded page of pending pairing requests, newest first.
	 *
	 * Existing {@link listPendingRequests} callers keep the legacy complete-array
	 * contract. This page API is intended for operator surfaces and carries the
	 * bounds into database adapters that support the extended batch query.
	 */
	async listPendingRequestsPage(
		channel: PairingChannel,
		options: PairingPageOptions = {},
	): Promise<PairingPage<PairingRequest>> {
		const { limit, offset } = normalizePairingPageOptions(options);
		const [result] = await this.runtime.getPairingRequests([
			{
				channel,
				agentId: this.runtime.agentId,
				limit,
				offset,
				order: "newest",
				createdAfter: this.requestExpiryCutoff(),
			},
		]);
		const validRequests = (result?.requests ?? []).filter(
			(request) => !this.isExpired(request),
		);

		if (result?.pageInfo) {
			return {
				items: this.newestFirst(validRequests),
				...result.pageInfo,
			};
		}

		// Compatibility fallback for third-party adapters that have not adopted
		// the optional page query fields yet. Official adapters return pageInfo
		// and perform the bound in storage.
		const ordered = this.newestFirst(validRequests);
		const page = ordered.slice(offset, offset + limit + 1);
		const hasMore = page.length > limit;
		return {
			items: page.slice(0, limit),
			...this.pageInfo(limit, offset, hasMore),
		};
	}

	/**
	 * Create or update a pairing request for a sender.
	 * If the sender already has a pending request, returns the existing code.
	 * If too many pending requests exist, returns empty code.
	 */
	async upsertRequest(
		params: UpsertPairingRequestParams,
	): Promise<UpsertPairingRequestResult> {
		const { channel, senderId, metadata } = params;
		const now = new Date();

		// Get existing requests for this channel
		const existingRequests = await this.listPendingRequests(channel);

		// Check if sender already has a pending request
		const existingRequest = existingRequests.find(
			(r) => r.senderId === senderId,
		);

		if (existingRequest) {
			// Update lastSeenAt and metadata
			const updatedRequest: PairingRequest = {
				...existingRequest,
				lastSeenAt: now,
				metadata: metadata ?? existingRequest.metadata,
			};
			await this.runtime.updatePairingRequest(updatedRequest);

			return {
				code: existingRequest.code,
				created: false,
				request: updatedRequest,
			};
		}

		// Check if we've hit the max pending requests limit
		if (existingRequests.length >= this.pairingConfig.maxPendingRequests) {
			// Prune oldest request to make room
			const oldest = existingRequests[0];
			if (oldest) {
				await this.runtime.deletePairingRequest(oldest.id);
			}
		}

		// Generate a new unique code
		const code = await this.generateUniqueCode(channel);

		// Create new request
		const newRequest: PairingRequest = {
			id: stringToUuid(`pairing-${channel}-${senderId}-${Date.now()}`),
			channel,
			senderId,
			code,
			createdAt: now,
			lastSeenAt: now,
			metadata,
			agentId: this.runtime.agentId,
		};

		await this.runtime.createPairingRequest(newRequest);

		this.runtime.logger.info(
			{
				src: "service:pairing",
				channel,
				senderId,
				code,
			},
			"Created new pairing request",
		);

		return {
			code,
			created: true,
			request: newRequest,
		};
	}

	/**
	 * Approve a pairing code and add the sender to the allowlist.
	 * Returns null if the code is not found or expired.
	 */
	async approveCode(
		params: ApprovePairingParams,
	): Promise<ApprovePairingResult | null> {
		const { channel, code } = params;
		const normalizedCode = code.trim().toUpperCase();

		if (!normalizedCode) {
			return null;
		}

		// Find the request with this code
		const requests = await this.listPendingRequests(channel);
		const request = requests.find(
			(r) => r.code.toUpperCase() === normalizedCode,
		);

		if (!request) {
			return null;
		}

		// Delete the pairing request
		await this.runtime.deletePairingRequest(request.id);

		// Add to allowlist
		const allowlistEntry: PairingAllowlistEntry = {
			id: stringToUuid(
				`allowlist-${channel}-${request.senderId}-${this.runtime.agentId}`,
			),
			channel,
			senderId: request.senderId,
			createdAt: new Date(),
			agentId: this.runtime.agentId,
			metadata: request.metadata,
		};

		await this.runtime.createPairingAllowlistEntry(allowlistEntry);

		this.runtime.logger.info(
			{
				src: "service:pairing",
				channel,
				senderId: request.senderId,
			},
			"Approved pairing request, added to allowlist",
		);

		return {
			senderId: request.senderId,
			request,
			allowlistEntry,
		};
	}

	/**
	 * Get the allowlist for a channel.
	 */
	async getAllowlist(
		channel: PairingChannel,
	): Promise<PairingAllowlistEntry[]> {
		const [result] = await this.runtime.getPairingAllowlists([
			{ channel, agentId: this.runtime.agentId },
		]);
		return result.entries;
	}

	/** Get one bounded page of allowlist entries, newest first. */
	async getAllowlistPage(
		channel: PairingChannel,
		options: PairingPageOptions = {},
	): Promise<PairingPage<PairingAllowlistEntry>> {
		const { limit, offset } = normalizePairingPageOptions(options);
		const [result] = await this.runtime.getPairingAllowlists([
			{
				channel,
				agentId: this.runtime.agentId,
				limit,
				offset,
				order: "newest",
			},
		]);

		if (result?.pageInfo) {
			return {
				items: this.newestFirst(result.entries),
				...result.pageInfo,
			};
		}

		const ordered = this.newestFirst(result?.entries ?? []);
		const page = ordered.slice(offset, offset + limit + 1);
		const hasMore = page.length > limit;
		return {
			items: page.slice(0, limit),
			...this.pageInfo(limit, offset, hasMore),
		};
	}

	/**
	 * Check if a sender is in the allowlist.
	 */
	async isAllowed(channel: PairingChannel, senderId: string): Promise<boolean> {
		const allowlist = await this.getAllowlist(channel);
		return allowlist.some((entry) => entry.senderId === senderId);
	}

	/**
	 * Add a sender directly to the allowlist (bypass pairing).
	 */
	async addToAllowlist(
		channel: PairingChannel,
		senderId: string,
		metadata?: Record<string, string>,
	): Promise<PairingAllowlistEntry> {
		// Check if already in allowlist
		const existing = await this.getAllowlist(channel);
		const existingEntry = existing.find((e) => e.senderId === senderId);
		if (existingEntry) {
			return existingEntry;
		}

		const entry: PairingAllowlistEntry = {
			id: stringToUuid(
				`allowlist-${channel}-${senderId}-${this.runtime.agentId}`,
			),
			channel,
			senderId,
			createdAt: new Date(),
			agentId: this.runtime.agentId,
			metadata,
		};

		await this.runtime.createPairingAllowlistEntry(entry);

		this.runtime.logger.info(
			{ src: "service:pairing", channel, senderId },
			"Added sender to allowlist",
		);

		return entry;
	}

	/**
	 * Remove a sender from the allowlist.
	 */
	async removeFromAllowlist(
		channel: PairingChannel,
		senderId: string,
	): Promise<boolean> {
		const allowlist = await this.getAllowlist(channel);
		const entry = allowlist.find((e) => e.senderId === senderId);

		if (!entry) {
			return false;
		}

		await this.runtime.deletePairingAllowlistEntry(entry.id);

		this.runtime.logger.info(
			{ src: "service:pairing", channel, senderId },
			"Removed sender from allowlist",
		);

		return true;
	}
}
