/**
 * Pairing Migration Utility
 *
 * Migrates data from the file-based pairing store (otto)
 * to the database-backed PairingService.
 *
 * This utility reads the JSON files used by otto's pairing system
 * and imports the data into the elizaOS database.
 */

import type { IAgentRuntime, UUID } from "../types";
import type {
	PairingRequest as DbPairingRequest,
	PairingChannel,
} from "../types/pairing";
import { ServiceType } from "../types/service";
import type { PairingService } from "./pairing";

/**
 * File-based pairing request format from otto.
 */
interface FilePairingRequest {
	id: string;
	code: string;
	createdAt: string;
	lastSeenAt: string;
	meta?: Record<string, string>;
}

/**
 * File-based pairing store format from otto.
 */
interface FilePairingStore {
	version: number;
	requests: FilePairingRequest[];
}

/**
 * File-based allowlist store format from otto.
 */
interface FileAllowFromStore {
	version: number;
	allowFrom: string[];
}

/**
 * Migration result for a single channel.
 */
export interface ChannelMigrationResult {
	channel: PairingChannel;
	requestsMigrated: number;
	allowlistEntriesMigrated: number;
	errors: string[];
}

/**
 * Overall migration result.
 */
export interface MigrationResult {
	success: boolean;
	channels: ChannelMigrationResult[];
	totalRequestsMigrated: number;
	totalAllowlistEntriesMigrated: number;
	errors: string[];
}

/**
 * Options for the migration.
 */
export interface MigrationOptions {
	/** Dry run - only report what would be migrated, don't actually migrate */
	dryRun?: boolean;
	/** Skip expired requests */
	skipExpired?: boolean;
	/** Expiration TTL in milliseconds (default: 1 hour) */
	expirationTtlMs?: number;
	/** Clear existing data before migration */
	clearExisting?: boolean;
}

const DEFAULT_EXPIRATION_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Parse a timestamp string to a Date object.
 */
function parseTimestamp(value: string | undefined): Date | null {
	if (!value) return null;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) return null;
	return new Date(parsed);
}

/**
 * Check if a request is expired.
 */
function isExpired(
	request: FilePairingRequest,
	now: Date,
	ttlMs: number,
): boolean {
	const createdAt = parseTimestamp(request.createdAt);
	if (!createdAt) return true;
	return now.getTime() - createdAt.getTime() > ttlMs;
}

/**
 * Get the PairingService from the runtime.
 */
async function getPairingService(
	runtime: IAgentRuntime,
): Promise<PairingService | null> {
	try {
		return runtime.getService(ServiceType.PAIRING) as PairingService | null;
	} catch {
		return null;
	}
}

/**
 * Migrate a single channel's pairing data from file-based store to database.
 *
 * @param runtime - The agent runtime
 * @param channel - The channel to migrate
 * @param pairingData - The pairing requests data
 * @param allowlistData - The allowlist data
 * @param options - Migration options
 * @returns Migration result for this channel
 */
export async function migrateChannelPairingData(
	runtime: IAgentRuntime,
	channel: PairingChannel,
	pairingData: FilePairingStore | null,
	allowlistData: FileAllowFromStore | null,
	options: MigrationOptions = {},
): Promise<ChannelMigrationResult> {
	const result: ChannelMigrationResult = {
		channel,
		requestsMigrated: 0,
		allowlistEntriesMigrated: 0,
		errors: [],
	};

	const pairingService = await getPairingService(runtime);
	if (!pairingService) {
		result.errors.push("PairingService not available");
		return result;
	}

	const {
		dryRun = false,
		skipExpired = true,
		expirationTtlMs = DEFAULT_EXPIRATION_TTL_MS,
		clearExisting = false,
	} = options;

	const now = new Date();

	// Clear existing data if requested
	if (clearExisting && !dryRun) {
		// This would require additional methods on PairingService
		// For now, we'll skip this functionality
		runtime.logger.warn(
			{ src: "pairing-migration", channel },
			"clearExisting option is not yet implemented",
		);
	}

	// Migrate pairing requests
	if (pairingData && Array.isArray(pairingData.requests)) {
		for (const fileRequest of pairingData.requests) {
			try {
				// Validate request
				if (!fileRequest.id || !fileRequest.code) {
					result.errors.push(`Invalid request: missing id or code`);
					continue;
				}

				// Check expiration
				if (skipExpired && isExpired(fileRequest, now, expirationTtlMs)) {
					runtime.logger.debug(
						{ src: "pairing-migration", channel, requestId: fileRequest.id },
						"Skipping expired request",
					);
					continue;
				}

				if (dryRun) {
					runtime.logger.info(
						{
							src: "pairing-migration",
							channel,
							requestId: fileRequest.id,
							code: fileRequest.code,
						},
						"Would migrate pairing request (dry run)",
					);
					result.requestsMigrated++;
					continue;
				}

				// Create the request in the database
				// Note: We use the database adapter directly to preserve the original code
				const dbRequest: Omit<DbPairingRequest, "agentId"> = {
					id: crypto.randomUUID() as UUID,
					channel,
					senderId: fileRequest.id,
					code: fileRequest.code.toUpperCase(),
					createdAt: parseTimestamp(fileRequest.createdAt) ?? now,
					lastSeenAt: parseTimestamp(fileRequest.lastSeenAt) ?? now,
					metadata: fileRequest.meta,
				};

				await runtime.createPairingRequest({
					...dbRequest,
					agentId: runtime.agentId,
				});

				result.requestsMigrated++;
				runtime.logger.info(
					{ src: "pairing-migration", channel, requestId: fileRequest.id },
					"Migrated pairing request",
				);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				result.errors.push(
					`Failed to migrate request ${fileRequest.id}: ${errorMsg}`,
				);
			}
		}
	}

	// Migrate allowlist entries
	if (allowlistData && Array.isArray(allowlistData.allowFrom)) {
		for (const senderId of allowlistData.allowFrom) {
			try {
				if (!senderId || typeof senderId !== "string") {
					continue;
				}

				const normalized = senderId.trim();
				if (!normalized) {
					continue;
				}

				if (dryRun) {
					runtime.logger.info(
						{ src: "pairing-migration", channel, senderId: normalized },
						"Would migrate allowlist entry (dry run)",
					);
					result.allowlistEntriesMigrated++;
					continue;
				}

				// Check if already in allowlist
				const existing = await pairingService.isAllowed(channel, normalized);
				if (existing) {
					runtime.logger.debug(
						{ src: "pairing-migration", channel, senderId: normalized },
						"Allowlist entry already exists, skipping",
					);
					continue;
				}

				await pairingService.addToAllowlist(channel, normalized);
				result.allowlistEntriesMigrated++;
				runtime.logger.info(
					{ src: "pairing-migration", channel, senderId: normalized },
					"Migrated allowlist entry",
				);
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				result.errors.push(
					`Failed to migrate allowlist entry ${senderId}: ${errorMsg}`,
				);
			}
		}
	}

	return result;
}

/**
 * Parse JSON safely, returning null on error.
 */
function safeParseJson<T>(raw: string): T | null {
	try {
		return JSON.parse(raw) as T;
	} catch {
		return null;
	}
}

/**
 * Migrate all channels from a directory of file-based pairing stores.
 *
 * This function expects the directory to contain files in the format:
 * - {channel}-pairing.json (pairing requests)
 * - {channel}-allowFrom.json (allowlist)
 *
 * @param runtime - The agent runtime
 * @param readFile - Function to read a file (path) => Promise<string>
 * @param listFiles - Function to list files in the directory
 * @param options - Migration options
 * @returns Overall migration result
 */
export async function migrateAllChannels(
	runtime: IAgentRuntime,
	readFile: (path: string) => Promise<string>,
	listFiles: () => Promise<string[]>,
	options: MigrationOptions = {},
): Promise<MigrationResult> {
	const result: MigrationResult = {
		success: true,
		channels: [],
		totalRequestsMigrated: 0,
		totalAllowlistEntriesMigrated: 0,
		errors: [],
	};

	try {
		const files = await listFiles();

		// Find unique channels from file names
		const channelSet = new Set<string>();
		for (const file of files) {
			const pairingMatch = file.match(/^(.+)-pairing\.json$/);
			const allowFromMatch = file.match(/^(.+)-allowFrom\.json$/);

			if (pairingMatch?.[1]) {
				channelSet.add(pairingMatch[1]);
			}
			if (allowFromMatch?.[1]) {
				channelSet.add(allowFromMatch[1]);
			}
		}

		// Migrate each channel
		for (const channelKey of channelSet) {
			try {
				// Read pairing data
				let pairingData: FilePairingStore | null = null;
				try {
					const pairingRaw = await readFile(`${channelKey}-pairing.json`);
					pairingData = safeParseJson<FilePairingStore>(pairingRaw);
				} catch {
					// File doesn't exist or couldn't be read
				}

				// Read allowlist data
				let allowlistData: FileAllowFromStore | null = null;
				try {
					const allowlistRaw = await readFile(`${channelKey}-allowFrom.json`);
					allowlistData = safeParseJson<FileAllowFromStore>(allowlistRaw);
				} catch {
					// File doesn't exist or couldn't be read
				}

				// Skip if no data
				if (!pairingData && !allowlistData) {
					runtime.logger.debug(
						{ src: "pairing-migration", channel: channelKey },
						"No data found for channel, skipping",
					);
					continue;
				}

				// Migrate the channel
				const channelResult = await migrateChannelPairingData(
					runtime,
					channelKey as PairingChannel,
					pairingData,
					allowlistData,
					options,
				);

				result.channels.push(channelResult);
				result.totalRequestsMigrated += channelResult.requestsMigrated;
				result.totalAllowlistEntriesMigrated +=
					channelResult.allowlistEntriesMigrated;

				if (channelResult.errors.length > 0) {
					result.errors.push(
						...channelResult.errors.map((e) => `[${channelKey}] ${e}`),
					);
				}
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				result.errors.push(
					`Failed to migrate channel ${channelKey}: ${errorMsg}`,
				);
				result.success = false;
			}
		}

		// Check overall success
		if (result.errors.length > 0) {
			result.success = false;
		}
	} catch (err) {
		const errorMsg = err instanceof Error ? err.message : String(err);
		result.errors.push(`Migration failed: ${errorMsg}`);
		result.success = false;
	}

	return result;
}

/**
 * Create a migration from file system paths.
 *
 * This is a convenience function for Node.js environments.
 *
 * @param runtime - The agent runtime
 * @param credentialsDir - Path to the credentials directory
 * @param options - Migration options
 * @returns Migration result
 */
export async function migrateFromFileSystem(
	runtime: IAgentRuntime,
	credentialsDir: string,
	options: MigrationOptions = {},
): Promise<MigrationResult> {
	// Import fs dynamically to support browser environments
	const fs = await import("node:fs/promises");
	const path = await import("node:path");

	const readFile = async (filename: string): Promise<string> => {
		const filePath = path.join(credentialsDir, filename);
		return fs.readFile(filePath, "utf-8");
	};

	const listFiles = async (): Promise<string[]> => {
		try {
			const entries = await fs.readdir(credentialsDir);
			return entries.filter(
				(e) => e.endsWith("-pairing.json") || e.endsWith("-allowFrom.json"),
			);
		} catch {
			return [];
		}
	};

	return migrateAllChannels(runtime, readFile, listFiles, options);
}
