/**
 * Covers the startup stranded-reaction scan (elizaOS/eliza#16318): the bot's
 * own in-progress markers (⏳/🤔) left by a hard kill are removed from recent
 * messages, terminal/others' reactions are untouched, every dimension of the
 * scan is hard-capped, failures are counted and logged, never thrown, and the
 * scan never eats a marker belonging to the CURRENT process (post-scan-start
 * messages and registry-active turns are excluded). Cached DMs are prioritized
 * inside the shared channel cap. Uses plain-object discord.js fakes, matching
 * service-shutdown-drain.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import {
	reconcileStrandedStatusReactions,
	STARTUP_SCAN_MAX_AGE_MS,
	STARTUP_SCAN_STARTED_AT_SKEW_MS,
} from "../startup-reaction-reconcile.ts";

const BOT_ID = "bot-user-1";
const NOW = 1_700_000_000_000;

function makeLogger() {
	return { info: vi.fn(), warn: vi.fn() };
}

function makeReaction(me: boolean) {
	return { me, users: { remove: vi.fn(async () => {}) } };
}

function makeMessage({
	ageMs = 60_000,
	reactions = {} as Record<string, ReturnType<typeof makeReaction>>,
	id = `message-${Math.random().toString(36).slice(2, 8)}`,
} = {}) {
	return {
		id,
		createdTimestamp: NOW - ageMs,
		reactions: {
			resolve: (emoji: string) => reactions[emoji],
		},
	};
}

function makeChannel(
	messages: ReturnType<typeof makeMessage>[],
	{ viewable = true, textBased = true, failFetch = false } = {},
) {
	return {
		id: `channel-${Math.random().toString(36).slice(2, 8)}`,
		viewable,
		isTextBased: () => textBased,
		messages: {
			fetch: vi.fn(async ({ limit }: { limit: number }) => {
				if (failFetch) throw new Error("Missing Access");
				return new Map(
					messages.slice(0, limit).map((message, index) => [index, message]),
				);
			}),
		},
	};
}

function makeClient(
	guildChannels: ReturnType<typeof makeChannel>[],
	{ dmChannels = [] as ReturnType<typeof makeChannel>[], botId = BOT_ID } = {},
) {
	const dmEntries = dmChannels.map(
		(channel) => [channel.id, { ...channel, isDMBased: () => true }] as const,
	);
	return {
		user: botId ? { id: botId } : null,
		guilds: {
			cache: new Map([
				[
					"guild-1",
					{
						channels: {
							cache: new Map(
								guildChannels.map((channel) => [channel.id, channel]),
							),
						},
					},
				],
			]),
		},
		channels: { cache: new Map(dmEntries) },
	};
}

function scan(
	client: ReturnType<typeof makeClient>,
	overrides: Record<string, unknown> = {},
) {
	return reconcileStrandedStatusReactions({
		client: client as unknown as Parameters<
			typeof reconcileStrandedStatusReactions
		>[0]["client"],
		logger: makeLogger(),
		now: () => NOW,
		...overrides,
	});
}

describe("reconcileStrandedStatusReactions", () => {
	it("removes the bot's own stranded in-progress markers and reports them", async () => {
		const thinking = makeReaction(true);
		const queued = makeReaction(true);
		const message = makeMessage({
			reactions: { "🤔": thinking, "⏳": queued },
		});
		const summary = await scan(makeClient([makeChannel([message])]));

		expect(thinking.users.remove).toHaveBeenCalledWith(BOT_ID);
		expect(queued.users.remove).toHaveBeenCalledWith(BOT_ID);
		expect(summary).toMatchObject({
			reactionsCleared: 2,
			failures: 0,
			timedOut: false,
		});
	});

	it("leaves other users' identical emojis untouched", async () => {
		const someoneElses = makeReaction(false);
		const message = makeMessage({ reactions: { "🤔": someoneElses } });
		const summary = await scan(makeClient([makeChannel([message])]));

		expect(someoneElses.users.remove).not.toHaveBeenCalled();
		expect(summary.reactionsCleared).toBe(0);
	});

	it("never asks for the terminal ❌ marker", async () => {
		const resolve = vi.fn(() => undefined);
		const message = {
			id: "message-terminal",
			createdTimestamp: NOW - STARTUP_SCAN_STARTED_AT_SKEW_MS - 1000,
			reactions: { resolve },
		};
		await scan(makeClient([makeChannel([message as never])]));

		const askedFor = resolve.mock.calls.map((call) => call[0]);
		expect(askedFor).not.toContain("❌");
		expect(askedFor).toEqual(expect.arrayContaining(["⏳", "🤔"]));
	});

	it("never removes a marker from a message created at or after scan start", async () => {
		// The current process's listeners bind before login: a marker on a
		// message newer than the scan's start is live state, not crash residue.
		const liveExact = makeReaction(true);
		const liveWithinSkew = makeReaction(true);
		const residue = makeReaction(true);
		const atScanStart = makeMessage({
			ageMs: 0,
			reactions: { "🤔": liveExact },
		});
		const withinSkew = makeMessage({
			ageMs: STARTUP_SCAN_STARTED_AT_SKEW_MS - 1,
			reactions: { "⏳": liveWithinSkew },
		});
		const beforeSkew = makeMessage({
			ageMs: STARTUP_SCAN_STARTED_AT_SKEW_MS + 1,
			reactions: { "🤔": residue },
		});
		const summary = await scan(
			makeClient([makeChannel([atScanStart, withinSkew, beforeSkew])]),
		);

		expect(liveExact.users.remove).not.toHaveBeenCalled();
		expect(liveWithinSkew.users.remove).not.toHaveBeenCalled();
		expect(residue.users.remove).toHaveBeenCalledWith(BOT_ID);
		expect(summary.reactionsCleared).toBe(1);
	});

	it("leaves markers whose message id is active in the turn-drain registry", async () => {
		const live = makeReaction(true);
		const residue = makeReaction(true);
		const activeMessage = makeMessage({
			id: "message-active-turn",
			reactions: { "🤔": live },
		});
		const idleMessage = makeMessage({
			id: "message-idle",
			reactions: { "🤔": residue },
		});
		const isTurnActive = vi.fn(
			(messageId: string) => messageId === "message-active-turn",
		);
		const summary = await scan(
			makeClient([makeChannel([activeMessage, idleMessage])]),
			{ isTurnActive },
		);

		expect(isTurnActive).toHaveBeenCalledWith("message-active-turn");
		expect(live.users.remove).not.toHaveBeenCalled();
		expect(residue.users.remove).toHaveBeenCalledWith(BOT_ID);
		expect(summary.reactionsCleared).toBe(1);
	});

	it("skips messages older than the age cap", async () => {
		const stale = makeReaction(true);
		const old = makeMessage({
			ageMs: STARTUP_SCAN_MAX_AGE_MS + 1,
			reactions: { "🤔": stale },
		});
		const summary = await scan(makeClient([makeChannel([old])]));

		expect(stale.users.remove).not.toHaveBeenCalled();
		expect(summary.messagesInspected).toBe(1);
		expect(summary.reactionsCleared).toBe(0);
	});

	it("honors the channel cap and per-channel message limit", async () => {
		const channels = Array.from({ length: 5 }, () =>
			makeChannel([makeMessage(), makeMessage(), makeMessage()]),
		);
		const summary = await scan(makeClient(channels), {
			maxChannels: 2,
			messagesPerChannel: 1,
		});

		expect(summary.channelsScanned).toBe(2);
		expect(summary.messagesInspected).toBe(2);
		expect(channels[0].messages.fetch).toHaveBeenCalledWith({ limit: 1 });
		expect(channels[2].messages.fetch).not.toHaveBeenCalled();
	});

	it("stops between channels when the time budget elapses and says so", async () => {
		const first = makeChannel([makeMessage()]);
		const second = makeChannel([makeMessage()]);
		let tick = 0;
		const summary = await reconcileStrandedStatusReactions({
			client: makeClient([first, second]) as unknown as Parameters<
				typeof reconcileStrandedStatusReactions
			>[0]["client"],
			logger: makeLogger(),
			// First call stamps startedAt; later calls step past the budget.
			now: () => NOW + 40_000 * tick++,
			timeBudgetMs: 30_000,
		});

		expect(summary.timedOut).toBe(true);
		expect(summary.channelsScanned).toBeLessThan(2);
	});

	it("counts a failed channel fetch, logs it, and continues", async () => {
		const broken = makeChannel([], { failFetch: true });
		const ok = makeReaction(true);
		const healthy = makeChannel([makeMessage({ reactions: { "🤔": ok } })]);
		const logger = makeLogger();
		const summary = await reconcileStrandedStatusReactions({
			client: makeClient([broken, healthy]) as unknown as Parameters<
				typeof reconcileStrandedStatusReactions
			>[0]["client"],
			logger,
			now: () => NOW,
		});

		expect(summary.failures).toBe(1);
		expect(summary.reactionsCleared).toBe(1);
		expect(logger.warn).toHaveBeenCalledTimes(1);
		expect(logger.warn.mock.calls[0][0]).toContain(broken.id);
	});

	it("counts a failed removal and keeps scanning", async () => {
		const failing = makeReaction(true);
		failing.users.remove = vi.fn(async () => {
			throw new Error("Missing Permissions");
		});
		const fine = makeReaction(true);
		const message = makeMessage({ reactions: { "⏳": failing, "🤔": fine } });
		const summary = await scan(makeClient([makeChannel([message])]));

		expect(summary.failures).toBe(1);
		expect(summary.reactionsCleared).toBe(1);
	});

	it("skips non-viewable and non-text channels, includes cached DMs", async () => {
		const hidden = makeChannel([makeMessage()], { viewable: false });
		const voice = makeChannel([makeMessage()], { textBased: false });
		const dmReaction = makeReaction(true);
		const dm = makeChannel([makeMessage({ reactions: { "🤔": dmReaction } })]);
		const summary = await scan(
			makeClient([hidden, voice], { dmChannels: [dm] }),
		);

		expect(summary.channelsScanned).toBe(1);
		expect(dmReaction.users.remove).toHaveBeenCalledWith(BOT_ID);
	});

	it("scans cached DMs before guild channels consume the shared cap", async () => {
		const guildFirst = makeChannel([makeMessage()]);
		const guildSecond = makeChannel([makeMessage()]);
		const dm = makeChannel([makeMessage()]);

		const summary = await scan(
			makeClient([guildFirst, guildSecond], { dmChannels: [dm] }),
			{ maxChannels: 2 },
		);

		expect(summary.channelsScanned).toBe(2);
		expect(dm.messages.fetch).toHaveBeenCalledTimes(1);
		expect(guildFirst.messages.fetch).toHaveBeenCalledTimes(1);
		expect(guildSecond.messages.fetch).not.toHaveBeenCalled();
	});

	it("skips entirely and warns when the client has no user id", async () => {
		const logger = makeLogger();
		const channel = makeChannel([makeMessage()]);
		const summary = await reconcileStrandedStatusReactions({
			client: makeClient([channel], { botId: "" }) as unknown as Parameters<
				typeof reconcileStrandedStatusReactions
			>[0]["client"],
			logger,
			now: () => NOW,
		});

		expect(summary.channelsScanned).toBe(0);
		expect(channel.messages.fetch).not.toHaveBeenCalled();
		expect(logger.warn).toHaveBeenCalledTimes(1);
	});
});
