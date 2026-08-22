/**
 * Surrogate safety for connector routing in the real MESSAGE action. Direct
 * parser checks and a deterministic mocked connector cover both parsing and
 * the production query passed across the connector boundary.
 */
import { describe, expect, test, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { IAgentRuntime, Memory } from "../../../types/index.ts";
import {
	messageAction,
	splitConnectorPrefix,
	splitConnectorSuffix,
} from "./message.ts";

describe("message action connector split surrogate safety", () => {
	test("prefix split with emoji in target remainder stays well-formed", () => {
		const fox = "🦊";
		const input = `discord:general-${fox}`;
		const res = splitConnectorPrefix(input);
		expect(res).toEqual({ source: "discord", target: `general-${fox}` });
	});

	test("suffix split with emoji in target body stays well-formed", () => {
		const fox = "🦊";
		const input = `hello world ${fox} on discord`;
		const res = splitConnectorSuffix(input);
		expect(res).toEqual({ source: "discord", target: `hello world ${fox}` });
	});

	test("lone surrogates in prefix and suffix targets are replaced exactly", () => {
		for (const surrogate of ["\ud800", "\udfff"]) {
			expect(splitConnectorPrefix(`discord:bad ${surrogate} channel`)).toEqual({
				source: "discord",
				target: "bad � channel",
			});
			expect(
				splitConnectorSuffix(`bad ${surrogate} channel on discord`),
			).toEqual({
				source: "discord",
				target: "bad � channel",
			});
		}
	});

	test("sweep whitespace offsets with emojis stay well-formed", () => {
		const fox = "🦊";
		for (let spaces = 1; spaces <= 5; spaces++) {
			const input = `topic ${fox}${" ".repeat(spaces)}on slack`;
			const res = splitConnectorSuffix(input);
			expect(res).toEqual({ source: "slack", target: `topic ${fox}` });
			expect(() => JSON.stringify(res)).not.toThrow();
		}
	});

	test("an explicitly sourced target is sanitized before connector resolution", async () => {
		const resolveTargets = vi.fn(async () => []);
		const runtime = createMockRuntime({
			agentId: "00000000-0000-0000-0000-000000000001",
			logger: { debug() {}, info() {}, warn() {}, error() {} },
			getMessageConnectors: () => [
				{
					source: "discord",
					label: "Discord",
					capabilities: [],
					supportedTargetKinds: ["channel"],
					contexts: [],
					resolveTargets,
				},
			],
			getRoom: async () => null,
			getEntitiesForRoom: async () => [],
			getEntityById: (async () => null) as IAgentRuntime["getEntityById"],
			getRelationships: (async () => []) as IAgentRuntime["getRelationships"],
			sendMessageToTarget: async () =>
				({
					id: "00000000-0000-0000-0000-000000000005",
				}) as Memory,
			reportError: () => undefined,
		});
		await messageAction.handler(
			runtime,
			{
				id: "00000000-0000-0000-0000-000000000002",
				roomId: "00000000-0000-0000-0000-000000000003",
				entityId: "00000000-0000-0000-0000-000000000004",
				agentId: runtime.agentId,
				content: { text: "send a message", source: "discord" },
			} as Memory,
			undefined,
			{
				parameters: {
					action: "send",
					source: "discord",
					target: "bad \ud800 channel",
					targetKind: "channel",
					message: "hello",
					persist: false,
				},
			},
		);
		expect(resolveTargets).toHaveBeenCalledWith(
			"bad � channel",
			expect.any(Object),
		);
	});
});
