import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const debouncerState = vi.hoisted(() => ({
	createChannelDebouncer: vi.fn(() => ({
		destroy: vi.fn(),
		enqueue: vi.fn(),
		flushAll: vi.fn(),
		markResponded: vi.fn(),
		pendingCount: vi.fn(() => 0),
	})),
	createMessageDebouncer: vi.fn(() => ({
		destroy: vi.fn(),
		enqueue: vi.fn(),
		flushAll: vi.fn(),
		pendingCount: vi.fn(() => 0),
	})),
}));

vi.mock("../debouncer", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../debouncer")>();
	return {
		...actual,
		createChannelDebouncer: debouncerState.createChannelDebouncer,
		createMessageDebouncer: debouncerState.createMessageDebouncer,
	};
});

import { setupDiscordEventListeners } from "../discord-events";

describe("setupDiscordEventListeners config", () => {
	it("uses resolved Discord service settings for mention-only mode", () => {
		const client = new EventEmitter();
		const service = {
			accountId: "test",
			allowAllSlashCommands: new Set(),
			allowedChannelIds: undefined,
			buildMemoryFromMessage: vi.fn(),
			character: {},
			client,
			discordSettings: {
				shouldIgnoreBotMessages: true,
				shouldRespondOnlyToMentions: false,
			},
			getChannelType: vi.fn(),
			handleGuildCreate: vi.fn(),
			handleGuildMemberAdd: vi.fn(),
			handleInteractionCreate: vi.fn(),
			handleReactionAdd: vi.fn(),
			handleReactionRemove: vi.fn(),
			isChannelAllowed: vi.fn(() => true),
			messageDebouncer: undefined,
			messageManager: undefined,
			resolveDiscordEntityId: vi.fn(),
			runtime: {
				emitEvent: vi.fn(),
				getSetting: vi.fn(() => undefined),
			},
			slashCommands: [],
			timeouts: [],
			userSelections: new Map(),
			voiceManager: undefined,
		};

		setupDiscordEventListeners(service as never);

		expect(debouncerState.createChannelDebouncer).toHaveBeenCalledWith(
			expect.any(Function),
			expect.objectContaining({
				shouldRespondOnlyToMentions: false,
			}),
		);
	});
});
