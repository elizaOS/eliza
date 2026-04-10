import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { shouldRespond } from "../basic-capabilities/index";
import { ChannelType } from "../index";
import type { Content, Memory, Room, UUID } from "../types";
import type { IAgentRuntime } from "../types/runtime";
import { cleanupTestRuntime, createTestRuntime } from "./test-utils";

describe("basic-capabilities shouldRespond", () => {
	let runtime: IAgentRuntime;
	let room: Room;

	beforeEach(async () => {
		runtime = await createTestRuntime();
		room = {
			id: "123e4567-e89b-12d3-a456-426614174002" as UUID,
			type: ChannelType.GROUP,
			name: "Group",
			worldId: "123e4567-e89b-12d3-a456-426614174003" as UUID,
			source: "test",
		};
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await cleanupTestRuntime(runtime);
	});

	function buildMessage(overrides: Partial<Content> = {}): Memory {
		return {
			id: "123e4567-e89b-12d3-a456-426614174014d" as UUID,
			content: {
				text: "hello",
				channelType: ChannelType.GROUP,
				...overrides,
			} as Content,
			entityId: "123e4567-e89b-12d3-a456-426614174005" as UUID,
			roomId: room.id,
			agentId: runtime.agentId,
			createdAt: Date.now(),
		};
	}

	it("uses legacy bypass settings when ALWAYS_RESPOND settings are unset", () => {
		vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
			const settings: Record<string, string | null> = {
				ALWAYS_RESPOND_CHANNELS: null,
				ALWAYS_RESPOND_SOURCES: null,
				SHOULD_RESPOND_BYPASS_TYPES: ChannelType.GROUP,
				SHOULD_RESPOND_BYPASS_SOURCES: "legacy_source",
			};
			return settings[key] ?? null;
		});

		expect(shouldRespond(runtime, buildMessage(), room)).toMatchObject({
			shouldRespond: true,
			skipEvaluation: true,
		});
		expect(
			shouldRespond(runtime, buildMessage({ source: "legacy_source" }), room),
		).toMatchObject({
			shouldRespond: true,
			skipEvaluation: true,
		});
	});

	it("treats an explicit empty ALWAYS_RESPOND setting as overriding the legacy alias", () => {
		vi.spyOn(runtime, "getSetting").mockImplementation((key: string) => {
			const settings: Record<string, string> = {
				ALWAYS_RESPOND_CHANNELS: "",
				ALWAYS_RESPOND_SOURCES: "",
				SHOULD_RESPOND_BYPASS_TYPES: ChannelType.GROUP,
				SHOULD_RESPOND_BYPASS_SOURCES: "legacy_source",
			};
			return settings[key] ?? null;
		});

		expect(
			shouldRespond(runtime, buildMessage({ source: "legacy_source" }), room),
		).toMatchObject({
			shouldRespond: false,
			skipEvaluation: false,
		});
	});
});
