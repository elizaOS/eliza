/**
 * Tests for the setup-progress providers and lossless Unicode normalization.
 * Provider cases drive the real exported providers through a minimal typed
 * runtime stub (getRoom/getWorld/reportError) — no harness stands in for the
 * module under test.
 */

import { describe, expect, it } from "vitest";
import type { Channel, IAgentRuntime, Memory, State, World } from "../types";
import { ChannelType } from "../types/primitives";
import type { SerializedSetupState, SetupContext } from "../types/setup";
import {
	normalizeSetupProgressText,
	type SetupStep,
	setupMissingProvider,
} from "./setup-progress";

function isWellFormed(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
			const next = value.charCodeAt(index + 1);
			if (!(next >= 0xdc00 && next <= 0xdfff)) {
				return false;
			}
			index += 1;
		} else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
			return false;
		}
	}
	return true;
}

describe("normalizeSetupProgressText Unicode boundaries", () => {
	it("preserves long surrogate-pair progress text completely", () => {
		const text = `${"a".repeat(6_000)}🦊${"b".repeat(50)}`;
		const out = normalizeSetupProgressText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("preserves fitting emoji without truncation", () => {
		const text = `${"a".repeat(100)}🦊`;
		const out = normalizeSetupProgressText(text);
		expect(out).toBe(text);
		expect(isWellFormed(out)).toBe(true);
	});

	it("sanitizes lone surrogates without shortening long text", () => {
		const lone = `setup \uD800 ${"b".repeat(6000)}`;
		const out = normalizeSetupProgressText(lone);
		expect(out).toContain("\uFFFD");
		expect(isWellFormed(out)).toBe(true);
		expect(out.length).toBe(lone.length);
	});

	it("sanitizes lone surrogates without truncation when fitting under limit", () => {
		const lone = "setup progress \uD800 current";
		const out = normalizeSetupProgressText(lone);
		expect(out).toBe("setup progress \uFFFD current");
		expect(isWellFormed(out)).toBe(true);
	});
});

describe("setupMissingProvider world resolution", () => {
	const roomId = "00000000-0000-0000-0000-000000000001" as Memory["roomId"];
	const message = { roomId } as Memory;
	const state = {} as State;

	function setupContext(overrides: Partial<SetupContext> = {}): SetupContext {
		return {
			currentStep: "WELCOME",
			completedSteps: [],
			settings: {},
			errors: [],
			startedAt: Date.now(),
			lastActivityAt: Date.now(),
			platform: "test",
			mode: "conversational",
			sessionId: "session-1",
			...overrides,
		};
	}

	function runtimeWith(
		room: Channel | null,
		world: World | null,
	): { runtime: IAgentRuntime; reportCalls: unknown[] } {
		const reportCalls: unknown[] = [];
		const runtime = {
			getRoom: async () => room,
			getWorld: async () => world,
			character: { name: "Agent" },
			reportError: (...args: unknown[]) => {
				reportCalls.push(args);
			},
		} as unknown as IAgentRuntime;
		return { runtime, reportCalls };
	}

	function dmRoom(worldId?: string): Channel {
		return {
			id: roomId,
			source: "test",
			type: ChannelType.DM,
			worldId,
		} as Channel;
	}

	function worldWithSetup(): World {
		const metadata: { setupStateMachine: SerializedSetupState } = {
			setupStateMachine: {
				version: 1,
				context: setupContext({
					currentStep: "RISK_ACK" as SetupStep,
				}),
			},
		};
		return {
			id: "00000000-0000-0000-0000-0000000000aa",
			agentId: "00000000-0000-0000-0000-0000000000bb",
			metadata,
		} as unknown as World;
	}

	it("renders the missing list for a DM whose world carries setup state", async () => {
		const { runtime, reportCalls } = runtimeWith(
			dmRoom("00000000-0000-0000-0000-0000000000aa"),
			worldWithSetup(),
		);
		const result = await setupMissingProvider.get(runtime, message, state);
		expect(result.text).toContain("Still needs configuration:");
		expect(result.text).toContain("Risk acknowledgement");
		expect(reportCalls).toHaveLength(0);
	});

	it("returns designed-empty — not unavailable — when the world no longer exists", async () => {
		// getWorld legitimately returns null (world deleted between getRoom and
		// getWorld). The old code read `.setupStateMachine` off undefined and
		// misrouted this healthy state into reportError + "unavailable".
		const { runtime, reportCalls } = runtimeWith(dmRoom("w"), null);
		const result = await setupMissingProvider.get(runtime, message, state);
		expect(result.text).toBe("");
		expect(result.values?.setupMissing).toBe("");
		expect(result.data).toEqual({ missing: [] });
		expect(reportCalls).toHaveLength(0);
	});

	it("returns designed-empty when the world has no metadata", async () => {
		// A plain world without metadata is normal, not a failure.
		const world = {
			id: "00000000-0000-0000-0000-0000000000aa",
			agentId: "00000000-0000-0000-0000-0000000000bb",
		} as World;
		const { runtime, reportCalls } = runtimeWith(
			dmRoom(world.id as string),
			world,
		);
		const result = await setupMissingProvider.get(runtime, message, state);
		expect(result.text).toBe("");
		expect(reportCalls).toHaveLength(0);
	});

	it("stays silent in non-DM rooms, matching SETUP_PROGRESS", async () => {
		// SETUP_PROGRESS gates on ChannelType.DM before touching world metadata;
		// SETUP_MISSING skipped that gate and would narrate setup state into a
		// group room.
		const room = {
			id: roomId,
			source: "test",
			type: ChannelType.GROUP,
			worldId: "00000000-0000-0000-0000-0000000000aa",
		} as Channel;
		const { runtime, reportCalls } = runtimeWith(room, worldWithSetup());
		const result = await setupMissingProvider.get(runtime, message, state);
		expect(result.text).toBe("");
		expect(reportCalls).toHaveLength(0);
	});
});
