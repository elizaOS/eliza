/**
 * Startup reconciliation of status reactions stranded by an unclean shutdown
 * (elizaOS/eliza#16318).
 *
 * The shutdown drain (#17749) reconciles reactions for turns it can observe,
 * but a hard-killed process (SIGKILL, OOM) never runs that path: the bot's
 * ⏳/🤔 stays on the message forever and the bot looks stuck. This scan runs
 * once per account after the client is ready and removes the bot's own
 * in-progress markers from recent messages. It removes rather than swaps to
 * ❌: by the time the process is back, the message may already have been
 * re-sent and answered, and stamping a retroactive error onto an old message
 * misleads more than a quiet cleanup.
 *
 * Every dimension is hard-capped (channels, messages per channel, message
 * age, wall-clock budget) so the scan completes quickly on large guilds, and
 * every failure is counted and logged with channel context, never thrown:
 * this runs detached from the ready path, where a rejection would be treated
 * as a terminal login failure.
 *
 * The scan must never eat a marker the CURRENT process just placed: message
 * listeners bind before login resolves, so a turn can start (and stamp ⏳/🤔)
 * before this scan runs. Two guards enforce that: messages created at or
 * after the scan started (minus a small clock-skew allowance) are skipped,
 * and the caller may pass `isTurnActive` so message ids tracked in the live
 * turn-drain registry are excluded regardless of timestamp.
 */
import type { Client, Message, TextBasedChannel } from "discord.js";
import { IN_PROGRESS_STATUS_EMOJIS } from "./status-reactions";

/** Setting/env name; set to "0" or "false" to disable the scan entirely. */
export const STARTUP_REACTION_SCAN_SETTING = "DISCORD_STARTUP_REACTION_SCAN";

/** Hard cap on channels inspected across all guilds plus cached DMs. */
export const STARTUP_SCAN_MAX_CHANNELS = 50;

/** Recent messages fetched per channel (one fetch per channel). */
export const STARTUP_SCAN_MESSAGES_PER_CHANNEL = 25;

/** Messages older than this are left alone even if a marker survives. */
export const STARTUP_SCAN_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Wall-clock budget for the whole scan. When it elapses the scan stops
 * between channels and reports `timedOut: true` — a partial cleanup that
 * says so beats an unbounded crawl of a large guild.
 */
export const STARTUP_SCAN_TIME_BUDGET_MS = 30_000;

/**
 * Messages created at or after `startedAt - skew` are never touched: they
 * postdate this process's message listeners, so any in-progress marker on
 * them belongs to a live turn, not a crashed predecessor. The skew absorbs
 * drift between the local clock and Discord's snowflake timestamps.
 */
export const STARTUP_SCAN_STARTED_AT_SKEW_MS = 5_000;

export interface StartupReconcileSummary {
	channelsScanned: number;
	messagesInspected: number;
	reactionsCleared: number;
	/** Fetch/remove failures — counted and logged, never thrown. */
	failures: number;
	/** True when the time budget elapsed before all channels were scanned. */
	timedOut: boolean;
}

interface ScanLogger {
	info: (message: string) => void;
	warn: (message: string) => void;
}

interface ReconcileOptions {
	client: Client;
	logger: ScanLogger;
	/** Injected clock for tests. */
	now?: () => number;
	/**
	 * Live-turn probe (the service passes the turn-drain registry). A message
	 * id reported active belongs to a turn this process is running right now;
	 * its marker is current state, not crash residue, and is skipped.
	 */
	isTurnActive?: (messageId: string) => boolean;
	/**
	 * DM channels re-opened from the persisted registry before the scan
	 * (elizaOS/eliza#18746). Scanned FIRST: cold-start DMs are the leg the
	 * channel cap must never starve, and on a cold boot the guild cache is
	 * large while the DM cache is empty.
	 */
	dmChannels?: unknown[];
	maxChannels?: number;
	messagesPerChannel?: number;
	maxAgeMs?: number;
	timeBudgetMs?: number;
	startedAtSkewMs?: number;
}

function channelLabel(channel: { id?: string }): string {
	return typeof channel?.id === "string" ? channel.id : "unknown-channel";
}

/**
 * Collect scannable channels: supplied/re-opened DMs first, then cached DMs,
 * then guild text channels the bot can read. DMs lead so the global cap
 * cannot starve them behind a large guild list (#18746).
 */
function collectChannels(
	client: Client,
	cap: number,
	dmChannels: unknown[] = [],
): TextBasedChannel[] {
	const channels: TextBasedChannel[] = [];
	const seen = new Set<string>();
	const push = (channel: unknown) => {
		if (channels.length >= cap) return;
		const candidate = channel as TextBasedChannel & {
			viewable?: boolean;
			isTextBased?: () => boolean;
			id: string;
		};
		if (!candidate || typeof candidate.isTextBased !== "function") return;
		if (!candidate.isTextBased()) return;
		if (candidate.viewable === false) return;
		if (seen.has(candidate.id)) return;
		seen.add(candidate.id);
		channels.push(candidate);
	};
	for (const channel of dmChannels) {
		push(channel);
		if (channels.length >= cap) return channels;
	}
	for (const channel of client.channels.cache.values()) {
		const dm = channel as { isDMBased?: () => boolean };
		if (typeof dm.isDMBased === "function" && dm.isDMBased()) push(channel);
		if (channels.length >= cap) return channels;
	}
	for (const guild of client.guilds.cache.values()) {
		for (const channel of guild.channels.cache.values()) {
			push(channel);
			if (channels.length >= cap) return channels;
		}
	}
	return channels;
}

/**
 * Re-open persisted DM channels ahead of the scan (elizaOS/eliza#18746).
 * `createDM` is idempotent for an existing DM; failures (deleted account,
 * blocked bot, network) are counted and logged, never thrown, and a channel
 * already in the cache costs no REST call.
 */
export async function reopenPersistedDms(options: {
	client: Client;
	records: { channelId: string; recipientId: string }[];
	logger: ScanLogger;
	limit?: number;
}): Promise<{ channels: unknown[]; failures: number }> {
	const { client, records, logger, limit = 16 } = options;
	const channels: unknown[] = [];
	let failures = 0;
	for (const record of records.slice(0, Math.max(0, limit))) {
		const cached = client.channels.cache.get(record.channelId);
		if (cached) {
			channels.push(cached);
			continue;
		}
		try {
			channels.push(await client.users.createDM(record.recipientId));
		} catch (error) {
			// error-policy:J6 A single unreachable recipient must not stop the
			// remaining DM re-opens or the scan behind them.
			failures += 1;
			logger.warn(
				`[DiscordService] Could not re-open persisted DM channel ${record.channelId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
	return { channels, failures };
}

export async function reconcileStrandedStatusReactions(
	options: ReconcileOptions,
): Promise<StartupReconcileSummary> {
	const {
		client,
		logger,
		now = Date.now,
		isTurnActive,
		maxChannels = STARTUP_SCAN_MAX_CHANNELS,
		messagesPerChannel = STARTUP_SCAN_MESSAGES_PER_CHANNEL,
		maxAgeMs = STARTUP_SCAN_MAX_AGE_MS,
		timeBudgetMs = STARTUP_SCAN_TIME_BUDGET_MS,
		startedAtSkewMs = STARTUP_SCAN_STARTED_AT_SKEW_MS,
	} = options;

	const summary: StartupReconcileSummary = {
		channelsScanned: 0,
		messagesInspected: 0,
		reactionsCleared: 0,
		failures: 0,
		timedOut: false,
	};
	const botId = client.user?.id;
	if (!botId) {
		logger.warn(
			"[DiscordService] Startup reaction scan skipped: client has no user id.",
		);
		return summary;
	}

	const startedAt = now();
	const channels = collectChannels(
		client,
		maxChannels,
		options.dmChannels ?? [],
	);

	for (const channel of channels) {
		if (now() - startedAt > timeBudgetMs) {
			summary.timedOut = true;
			break;
		}
		summary.channelsScanned += 1;
		let messages: Iterable<Message>;
		try {
			const fetched = await channel.messages.fetch({
				limit: messagesPerChannel,
			});
			messages = fetched.values();
		} catch (error) {
			// error-policy:J6 best-effort residue cleanup; a channel we cannot
			// read is counted, warned with its id, and skipped — one revoked
			// channel must not abort the scan of the rest.
			summary.failures += 1;
			logger.warn(
				`[DiscordService] Startup reaction scan could not fetch messages in channel ${channelLabel(channel)}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			continue;
		}
		for (const message of messages) {
			summary.messagesInspected += 1;
			const age = now() - message.createdTimestamp;
			if (age > maxAgeMs) continue;
			// Never touch a message this process could have marked itself:
			// listeners bind before login, so a turn (and its ⏳/🤔) can exist
			// before this scan runs. Crash residue is by definition older than
			// this process.
			if (message.createdTimestamp >= startedAt - startedAtSkewMs) continue;
			if (isTurnActive?.(message.id) === true) continue;
			for (const emoji of IN_PROGRESS_STATUS_EMOJIS) {
				const reaction = message.reactions?.resolve(emoji);
				// `me` is populated on fetched messages; only the bot's own
				// marker is crash residue — other users' identical emojis are
				// their reactions, not ours to remove.
				if (reaction?.me !== true) continue;
				try {
					await reaction.users.remove(botId);
					summary.reactionsCleared += 1;
				} catch (error) {
					// error-policy:J6 best-effort residue cleanup; a failed removal
					// (deleted message, revoked permission) is counted and warned,
					// and the scan keeps going — the marker simply stays stranded.
					summary.failures += 1;
					logger.warn(
						`[DiscordService] Startup reaction scan could not remove ${emoji} in channel ${channelLabel(channel)}: ${
							error instanceof Error ? error.message : String(error)
						}`,
					);
				}
			}
		}
	}

	logger.info(
		`[DiscordService] Startup reaction scan: ${summary.reactionsCleared} stranded marker(s) cleared across ${summary.channelsScanned} channel(s), ${summary.messagesInspected} message(s) inspected, ${summary.failures} failure(s)${summary.timedOut ? ", stopped at time budget" : ""}.`,
	);
	return summary;
}
