/**
 * The runtime sends no output cap a call did not ask for. A
 * `<model type>_MAX_TOKENS` or `DEFAULT_MAX_TOKENS` setting used to cap every
 * call that sent none; output is now uncapped unless the caller names a cap,
 * and the other sampling settings still merge under the call's own params.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
import { parseAndValidateCharacter } from "../src/character-schema";
import { ModelType } from "../src/types/model.ts";

let runtime: ReturnType<typeof createSQLiteTestRuntime> | undefined;
afterEach(async () => {
	await runtime?.stop();
	runtime = undefined;
});

/** A host with `settings`, and what its text handlers receive per call. */
function hostWith(settings: Record<string, string>) {
	const host = createSQLiteTestRuntime({
		character: { name: "OutputCapSetting", bio: [] },
		settings,
		logLevel: "fatal",
	});
	runtime = host;
	const received: unknown[] = [];
	for (const modelType of [ModelType.TEXT_SMALL, ModelType.TEXT_LARGE]) {
		host.registerModel(
			modelType,
			async (_runtime, params) => {
				received.push(params);
				return "ok";
			},
			"scripted",
		);
	}
	const sent = async (
		modelType: typeof ModelType.TEXT_SMALL | typeof ModelType.TEXT_LARGE,
		params: unknown,
	) => {
		await host.useModel(modelType, params as never);
		return received.pop();
	};
	return { sent };
}

/** Every cap setting the runtime once merged, set small. */
const CAP_SETTINGS = {
	TEXT_SMALL_MAX_TOKENS: "16",
	TEXT_LARGE_MAX_TOKENS: "16",
	DEFAULT_MAX_TOKENS: "16",
};

describe("output cap settings", () => {
	it.each([ModelType.TEXT_SMALL, ModelType.TEXT_LARGE] as const)(
		"sends a %s call that names no cap none",
		async (modelType) => {
			const { sent } = hostWith(CAP_SETTINGS);
			const received = await sent(modelType, { prompt: "Say hello." });
			expect(received).toMatchObject({ prompt: "Say hello." });
			expect(received).not.toHaveProperty("maxTokens");
		},
	);

	it("keeps the cap a call sends", async () => {
		const { sent } = hostWith(CAP_SETTINGS);
		expect(
			await sent(ModelType.TEXT_SMALL, {
				prompt: "Say hello.",
				maxTokens: 256,
			}),
		).toMatchObject({ maxTokens: 256 });
	});

	it("still merges the other sampling settings", async () => {
		const { sent } = hostWith({
			...CAP_SETTINGS,
			TEXT_SMALL_TEMPERATURE: "0.25",
			DEFAULT_TOP_P: "0.5",
		});
		const received = await sent(ModelType.TEXT_SMALL, { prompt: "Say hello." });
		expect(received).toMatchObject({ temperature: 0.25, topP: 0.5 });
		expect(received).not.toHaveProperty("maxTokens");
	});

	it("passes on params that are not an object as they were sent", async () => {
		const { sent } = hostWith(CAP_SETTINGS);
		expect(await sent(ModelType.TEXT_SMALL, "Say hello.")).toBe("Say hello.");
	});
});

describe("retired character cap settings", () => {
	it("loads a legacy character without carrying its default output cap", () => {
		const result = parseAndValidateCharacter(
			JSON.stringify({
				name: "legacy-character",
				settings: { defaultMaxTokens: 16, defaultTemperature: 0.25 },
			}),
		);
		expect(result).toMatchObject({
			success: true,
			data: { settings: { defaultTemperature: 0.25 } },
		});
		expect(result.data?.settings).not.toHaveProperty("defaultMaxTokens");
		expect(result.data?.settings?.extra).toBeUndefined();
	});

	it("rejects maxReplyTokens instead of moving it into extra", () => {
		const result = parseAndValidateCharacter(
			JSON.stringify({ name: "retired-cap", settings: { maxReplyTokens: 16 } }),
		);
		expect(result.success).toBe(false);
	});
});
