/**
 * Unit tests for checkSecretHandler.
 * Consolidated from colocated and __tests__/check-secret suites.
 * Preserves all unique assertions: service unavailable, per-key presence
 * with missing list, no-keys failure, string param handling, and
 * non-leakage of secret values.
 */
import { describe, expect, it, test, vi } from "vitest";
import { ChannelType } from "../../../types/primitives";

const mocks = vi.hoisted(() => ({
	logger: { debug: vi.fn(), warn: vi.fn(), info: vi.fn() },
	secretContextFromMessage: vi.fn(),
}));

vi.mock("../../../logger.ts", () => ({ logger: mocks.logger }));
vi.mock("../secret-context.ts", () => ({
	secretContextFromMessage: (...a: unknown[]) =>
		mocks.secretContextFromMessage(...a),
}));
vi.mock("../services/secrets.ts", () => ({
	SECRETS_SERVICE_TYPE: "SECRETS",
}));

import { checkSecretHandler } from "./check-secret";

function createRuntime(present: Record<string, boolean>) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS") {
				return {
					exists: async (key: string) => present[key] === true,
				};
			}
			return null;
		},
		getSetting: () => undefined,
		composeState: async () => ({}),
		dynamicPromptExecFromState: async () => ({}),
	};
}

function createMessage() {
	return {
		entityId: "user-1",
		roomId: "room-1",
		content: { text: "", channelType: ChannelType.DM },
	};
}

describe("checkSecretHandler", () => {
	it("returns failure when the secrets service is unavailable", async () => {
		const runtime = { getService: () => null } as never;
		const result = await checkSecretHandler(runtime, {} as never);
		expect(result.success).toBe(false);
		expect(result.text).toBe("Secrets service not available");
	});

	test("reports per-key presence and missing list (colocated)", async () => {
		mocks.secretContextFromMessage.mockReturnValue({ level: "user" });
		const result = await checkSecretHandler(
			createRuntime({
				OPENAI_API_KEY: true,
				ANTHROPIC_API_KEY: false,
			}) as never,
			createMessage() as never,
			undefined,
			{
				parameters: { key: ["OPENAI_API_KEY", "ANTHROPIC_API_KEY"] },
			} as never,
			async () => [],
		);
		expect(result.success).toBe(true);
		const data = result.data as { present: boolean[]; missing: string[] };
		expect(data.present).toEqual([true, false]);
		expect(data.missing).toEqual(["ANTHROPIC_API_KEY"]);
	});

	test("fails when no keys are provided (colocated)", async () => {
		mocks.secretContextFromMessage.mockReturnValue(undefined);
		const result = await checkSecretHandler(
			createRuntime({}) as never,
			createMessage() as never,
			undefined,
			{ parameters: {} } as never,
			async () => [],
		);
		expect(result.success).toBe(false);
		expect(result.text).toContain("key");
	});

	it("reports which keys exist without returning values", async () => {
		mocks.secretContextFromMessage.mockReturnValue({ level: "user" });
		const service = {
			exists: vi.fn(async (key: string) => key === "API_KEY"),
		};
		const runtime = { getService: () => service } as never;
		const result = await checkSecretHandler(runtime, {} as never, undefined, {
			parameters: { key: ["api-key", "MISSING_KEY"] },
		} as never);
		expect(result.success).toBe(true);
		const data = result.data as { present: boolean[]; missing: string[] };
		expect(data.present).toEqual([true, false]);
		expect(data.missing).toEqual(["MISSING_KEY"]);
		expect(result.text).toContain("Missing: MISSING_KEY");
		expect(JSON.stringify(result)).not.toContain("the-value");
	});

	it("handles string params and rejects missing keys", async () => {
		mocks.secretContextFromMessage.mockReturnValue(undefined);
		const service = { exists: vi.fn(async () => false) };
		const runtime = { getService: () => service } as never;
		const r1 = await checkSecretHandler(runtime, {} as never, undefined, {
			parameters: { key: "SINGLE" },
		} as never);
		expect(r1.success).toBe(true);
		const r2 = await checkSecretHandler(runtime, {} as never, undefined, {
			parameters: {},
		} as never);
		expect(r2.success).toBe(false);
		expect(r2.text).toBe("Missing required parameter: key");
	});
});
