/**
 * A permission-audit listener must not leave an unhandled rejection behind when
 * a registered event listener throws. `runtime.emitEvent` runs every listener
 * and rejects when one fails; discord.js ignores the promise the handler
 * returns, so the rejection reached the process and Node exits the agent. The
 * failure is reported through `runtime.reportError` instead.
 */
import { describe, expect, it, vi } from "vitest";
import { setupDiscordEventListeners } from "../discord-events.ts";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";

function harness() {
	const handlers = new Map<string, (...args: unknown[]) => unknown>();
	const emitEvent = vi.fn(async () => {
		throw new Error("listener boom");
	});
	const reportError = vi.fn();
	const service = {
		runtime: {
			agentId: AGENT_ID,
			getSetting: (key: string) =>
				key === "DISCORD_AUDIT_LOG_ENABLED" ? "true" : undefined,
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			emitEvent,
			reportError,
		},
		client: {
			user: { id: "bot-1" },
			on: (event: string, handler: (...args: unknown[]) => unknown) => {
				handlers.set(event, handler);
			},
			once() {},
		},
		messageManager: { handleMessage: async () => {} },
		discordSettings: {},
	};
	const { channelDebouncer } = setupDiscordEventListeners(
		service as unknown as Parameters<typeof setupDiscordEventListeners>[0],
	);
	return { handlers, emitEvent, reportError, channelDebouncer };
}

const guild = {
	id: "guild-1",
	name: "Guild One",
	// Audit-log reads degrade on their own; the permission event still emits.
	fetchAuditLogs: async () => {
		throw new Error("missing permissions");
	},
};

const role = {
	id: "role-1",
	name: "Moderator",
	permissions: { toArray: () => ["ManageGuild"] },
	guild,
};

describe("Discord permission-audit listener failures", () => {
	it.each([
		["roleCreate", role],
		["roleDelete", role],
	])(
		"reports a failing %s emission instead of leaving it unhandled",
		async (eventName, payload) => {
			const { handlers, emitEvent, reportError, channelDebouncer } = harness();
			try {
				await handlers.get(eventName)?.(payload);
				expect(emitEvent).toHaveBeenCalledTimes(1);
				expect(reportError).toHaveBeenCalledWith(
					"discord:emit-event",
					expect.any(Error),
					expect.anything(),
				);
			} finally {
				channelDebouncer.destroy();
			}
		},
	);
});
