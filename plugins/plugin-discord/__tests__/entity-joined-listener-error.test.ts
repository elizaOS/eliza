/**
 * Covers the ENTITY_JOINED listener-failure path in
 * `DiscordService.handleGuildMemberAdd` (PR #37151 review):
 *
 * - The handler promise stays pending until every ENTITY_JOINED listener
 *   settles. The event is awaited in the service path (which the gateway in
 *   `discord-events.ts` already awaits inside a try/catch) instead of being
 *   detached, so the member-add handler never resolves before listener work
 *   is done.
 * - A listener that rejects (or throws synchronously) is diagnosed through
 *   `runtime.reportError("discord:emit-event", ...)` instead of escaping as an
 *   unhandled rejection. The failure is non-fatal for member onboarding: the
 *   handler still resolves normally.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type { GuildMember } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { DiscordService } from "../service.ts";
import { DiscordEventTypes } from "../types.ts";

function makeLogger() {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	};
}

function createRuntime(emitEvent: IAgentRuntime["emitEvent"]) {
	const reportError = vi.fn();
	const runtime = {
		agentId: "test-agent-id",
		character: { settings: {} },
		logger: makeLogger(),
		getSetting: () => undefined,
		emitEvent,
		reportError,
	} as unknown as IAgentRuntime;
	return { runtime, reportError };
}

function makeMember(): GuildMember {
	return {
		id: "member-123",
		guild: { id: "guild-456" },
		user: { username: "newbie", bot: false, discriminator: "0" },
		displayName: "Newbie",
		roles: { cache: { map: () => [] as string[] } },
		joinedAt: undefined,
	} as unknown as GuildMember;
}

async function flushMicrotasks(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("handleGuildMemberAdd ENTITY_JOINED listener failures", () => {
	it("keeps the handler pending until the listener settles", async () => {
		let resolveEmit!: () => void;
		const emitEvent = vi.fn(
			() =>
				new Promise<void>((resolve) => {
					resolveEmit = resolve;
				}),
		);
		const { runtime, reportError } = createRuntime(
			emitEvent as unknown as IAgentRuntime["emitEvent"],
		);
		const service = new DiscordService(runtime);

		let settled = false;
		const pending = service.handleGuildMemberAdd(makeMember()).then(() => {
			settled = true;
		});

		await flushMicrotasks();
		expect(emitEvent).toHaveBeenCalledTimes(1);
		// The handler must not resolve before the listener finishes.
		expect(settled).toBe(false);

		resolveEmit();
		await pending;
		expect(settled).toBe(true);
		expect(reportError).not.toHaveBeenCalled();
	});

	it("reports a rejecting listener instead of an unhandled rejection", async () => {
		const listenerError = new Error("listener boom");
		const emitEvent = vi.fn(async () => {
			throw listenerError;
		});
		const { runtime, reportError } = createRuntime(
			emitEvent as unknown as IAgentRuntime["emitEvent"],
		);
		const service = new DiscordService(runtime);

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on("unhandledRejection", onUnhandled);
		try {
			// Non-fatal: the handler resolves even though the listener failed.
			await service.handleGuildMemberAdd(makeMember());
		} finally {
			process.removeListener("unhandledRejection", onUnhandled);
		}

		expect(reportError).toHaveBeenCalledWith(
			"discord:emit-event",
			listenerError,
			{ eventName: DiscordEventTypes.ENTITY_JOINED },
		);
		expect(unhandled).toHaveLength(0);
	});

	it("reports a synchronously throwing emitEvent and still resolves", async () => {
		const listenerError = new Error("sync boom");
		const emitEvent = vi.fn(() => {
			throw listenerError;
		});
		const { runtime, reportError } = createRuntime(
			emitEvent as unknown as IAgentRuntime["emitEvent"],
		);
		const service = new DiscordService(runtime);

		await expect(
			service.handleGuildMemberAdd(makeMember()),
		).resolves.toBeUndefined();
		expect(reportError).toHaveBeenCalledWith(
			"discord:emit-event",
			listenerError,
			{ eventName: DiscordEventTypes.ENTITY_JOINED },
		);
	});
});
