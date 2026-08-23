/**
 * Bounded persistence of observed DM channels so the startup reaction scan
 * can reach DMs on a COLD restart (elizaOS/eliza#18746).
 *
 * Bots cannot enumerate their open DM channels: on a cold boot
 * `client.channels.cache` holds no DMs until a DM gateway event arrives, so a
 * marker stranded in a DM by a hard kill survives exactly the restart that is
 * supposed to clean it up. This registry records `{channelId, recipientId}`
 * pairs as DMs are observed during normal operation and lets the scan re-open
 * them (`client.users.createDM`, i.e. `POST /users/@me/channels` — idempotent
 * for an existing DM) before scanning.
 *
 * Deliberately minimal state: ids and a last-seen timestamp only, no message
 * content, no usernames. Bounded LRU (newest wins) so the file can never grow
 * with guild count or traffic. All I/O failures degrade to an empty registry
 * and a logged warning: DM cleanup is best-effort, service start is not.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** Newest entries kept; older observations age out. */
export const DM_REGISTRY_MAX_ENTRIES = 64;

export interface DmChannelRecord {
	channelId: string;
	recipientId: string;
	lastSeenAt: number;
}

interface RegistryFile {
	version: 1;
	entries: DmChannelRecord[];
}

interface RegistryLogger {
	warn: (message: string) => void;
}

interface DmRegistryOptions {
	/** Absolute path of the registry JSON file (state dir, per account). */
	filePath: string;
	logger: RegistryLogger;
	now?: () => number;
	maxEntries?: number;
}

function isRecord(value: unknown): value is DmChannelRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.channelId === "string" &&
		record.channelId.length > 0 &&
		typeof record.recipientId === "string" &&
		record.recipientId.length > 0 &&
		typeof record.lastSeenAt === "number" &&
		Number.isFinite(record.lastSeenAt)
	);
}

export class DmChannelRegistry {
	private readonly filePath: string;
	private readonly logger: RegistryLogger;
	private readonly now: () => number;
	private readonly maxEntries: number;
	/** channelId -> record; Map preserves insertion order for LRU trimming. */
	private entries = new Map<string, DmChannelRecord>();
	private loaded = false;

	constructor(options: DmRegistryOptions) {
		this.filePath = options.filePath;
		this.logger = options.logger;
		this.now = options.now ?? Date.now;
		this.maxEntries = options.maxEntries ?? DM_REGISTRY_MAX_ENTRIES;
	}

	private load(): void {
		if (this.loaded) return;
		this.loaded = true;
		let raw: string;
		try {
			raw = readFileSync(this.filePath, "utf8");
		} catch {
			// First run or removed state dir — an empty registry is the
			// correct cold state, not an error.
			return;
		}
		try {
			const parsed = JSON.parse(raw) as RegistryFile;
			if (parsed?.version !== 1 || !Array.isArray(parsed.entries)) {
				throw new TypeError("unexpected registry shape");
			}
			for (const entry of parsed.entries.filter(isRecord)) {
				this.entries.set(entry.channelId, entry);
			}
		} catch (error) {
			// error-policy:J6 A corrupt registry degrades to empty (DM cleanup
			// is best-effort); the warning keeps the corruption observable.
			this.logger.warn(
				`[DiscordService] DM channel registry unreadable at ${this.filePath}; starting empty: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			this.entries = new Map();
		}
	}

	/** Record an observed DM channel; newest observation wins the LRU slot. */
	record(channelId: string, recipientId: string): void {
		if (!channelId || !recipientId) return;
		this.load();
		this.entries.delete(channelId);
		this.entries.set(channelId, {
			channelId,
			recipientId,
			lastSeenAt: this.now(),
		});
		while (this.entries.size > this.maxEntries) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			this.entries.delete(oldest);
		}
		this.persist();
	}

	/** Newest first, for scan ordering under the channel cap. */
	listRecent(limit = this.maxEntries): DmChannelRecord[] {
		this.load();
		return [...this.entries.values()]
			.sort(
				(a, b) =>
					(Number.isFinite(b.lastSeenAt) ? b.lastSeenAt : 0) -
					(Number.isFinite(a.lastSeenAt) ? a.lastSeenAt : 0),
			)
			.slice(0, Math.max(0, limit));
	}

	private persist(): void {
		const payload: RegistryFile = {
			version: 1,
			entries: [...this.entries.values()],
		};
		try {
			// The state subdirectory does not exist on first use; creating it
			// here keeps the constructor I/O-free.
			mkdirSync(dirname(this.filePath), { recursive: true });
			const tmp = `${this.filePath}.tmp`;
			writeFileSync(tmp, JSON.stringify(payload), "utf8");
			renameSync(tmp, this.filePath);
		} catch (error) {
			// error-policy:J6 Persistence is best-effort; losing it costs one
			// cold-start DM sweep, never message handling.
			this.logger.warn(
				`[DiscordService] DM channel registry write failed at ${this.filePath}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}
