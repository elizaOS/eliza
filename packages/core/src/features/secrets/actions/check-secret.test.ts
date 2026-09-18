/**
 * Exercises `checkSecretHandler`, the SECRETS umbrella's `action=check` path,
 * which reports per-key presence and a missing list without ever returning
 * values, and fails when no keys are supplied. The runtime is a deterministic
 * stub whose `SECRETS` service returns canned `exists()` answers — no live
 * model or database.
 */

import { describe, expect, test, vi } from "vitest";
import { ChannelType } from "../../../types/primitives";
import { checkSecretHandler } from "./check-secret";

const SECRET_VALUE_SENTINEL = "the-value";

function createRuntime(
	present: Record<string, boolean>,
	options: {
		available?: boolean;
		get?: (key: string) => Promise<string | null>;
	} = {},
) {
	return {
		agentId: "agent-1",
		getService: (name: string) => {
			if (name === "SECRETS" && options.available !== false) {
				return {
					exists: async (key: string) => present[key] === true,
					get: options.get ?? (async () => null),
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

describe("SECRETS action=check", () => {
	test("fails when the secrets service is unavailable", async () => {
		const result = await checkSecretHandler(
			createRuntime({}, { available: false }) as never,
			createMessage() as never,
		);

		expect(result.success).toBe(false);
		expect(result.text).toBe("Secrets service not available");
	});

	test("normalizes keys and reports presence without reading values", async () => {
		const getSecret = vi.fn(async () => SECRET_VALUE_SENTINEL);
		const result = await checkSecretHandler(
			createRuntime(
				{
					API_KEY: true,
					MISSING_KEY: false,
				},
				{ get: getSecret },
			) as never,
			createMessage() as never,
			undefined,
			{
				parameters: { key: ["api-key", "MISSING_KEY"] },
			} as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { present: boolean[]; missing: string[] };
		expect(data.present).toEqual([true, false]);
		expect(data.missing).toEqual(["MISSING_KEY"]);
		expect(result.text).toBe("Missing: MISSING_KEY.");
		expect(getSecret).not.toHaveBeenCalled();
		expect(JSON.stringify(result)).not.toContain(SECRET_VALUE_SENTINEL);
	});

	test("accepts a string key parameter", async () => {
		const result = await checkSecretHandler(
			createRuntime({ SINGLE: false }) as never,
			createMessage() as never,
			undefined,
			{ parameters: { key: "single" } } as never,
			async () => [],
		);

		expect(result.success).toBe(true);
		const data = result.data as { present: boolean[]; missing: string[] };
		expect(data.present).toEqual([false]);
		expect(data.missing).toEqual(["SINGLE"]);
	});

	test("fails when no keys are provided", async () => {
		const result = await checkSecretHandler(
			createRuntime({}) as never,
			createMessage() as never,
			undefined,
			{ parameters: {} } as never,
			async () => [],
		);

		expect(result.success).toBe(false);
		expect(result.text).toBe("Missing required parameter: key");
	});
});
