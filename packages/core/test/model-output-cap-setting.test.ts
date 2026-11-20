/**
 * A `<model type>_MAX_TOKENS` runtime setting caps the output of that model
 * type's calls that send no cap of their own, and nothing else: a call's own
 * cap wins, and another model type's calls stay as they were sent.
 */
import { createSQLiteTestRuntime } from "@elizaos/testing/runtime";
import { afterEach, describe, expect, it } from "vitest";
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

describe("output cap setting", () => {
	it("caps a call that sends no cap", async () => {
		const { sent } = hostWith({ TEXT_SMALL_MAX_TOKENS: "4096" });
		expect(
			await sent(ModelType.TEXT_SMALL, { prompt: "Say hello." }),
		).toMatchObject({ prompt: "Say hello.", maxTokens: 4096 });
	});

	it("leaves the cap a call sends", async () => {
		const { sent } = hostWith({ TEXT_SMALL_MAX_TOKENS: "4096" });
		expect(
			await sent(ModelType.TEXT_SMALL, {
				prompt: "Say hello.",
				maxTokens: 256,
			}),
		).toMatchObject({ maxTokens: 256 });
	});

	it("adds no cap when the host sets none", async () => {
		const { sent } = hostWith({});
		expect(
			await sent(ModelType.TEXT_SMALL, { prompt: "Say hello." }),
		).not.toHaveProperty("maxTokens");
	});

	it("leaves another model type's calls uncapped", async () => {
		const { sent } = hostWith({ TEXT_SMALL_MAX_TOKENS: "4096" });
		expect(
			await sent(ModelType.TEXT_LARGE, { prompt: "Say hello." }),
		).not.toHaveProperty("maxTokens");
	});

	// The setting is merged under the call's own params, so a call that names
	// the cap and leaves it undefined still sends none.
	it("does not cap a call that passes an undefined cap", async () => {
		const { sent } = hostWith({ TEXT_SMALL_MAX_TOKENS: "4096" });
		const received = (await sent(ModelType.TEXT_SMALL, {
			prompt: "Say hello.",
			maxTokens: undefined,
		})) as { maxTokens?: number };
		expect(received.maxTokens).toBeUndefined();
	});

	it("passes on params that are not an object as they were sent", async () => {
		const { sent } = hostWith({ TEXT_SMALL_MAX_TOKENS: "4096" });
		expect(await sent(ModelType.TEXT_SMALL, "Say hello.")).toBe("Say hello.");
	});
});
