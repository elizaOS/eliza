import { describe, expect, it } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime, NoModelProviderConfiguredError } from "../runtime";
import { ModelType } from "../types/model";

function createRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "No Provider Test Agent",
			username: "no-provider-test-agent",
			clients: [],
			settings: {},
		},
		adapter: new InMemoryDatabaseAdapter(),
		// Disable native feature plugins so we don't accidentally pick up an
		// embedding-only handler that would still leave text models unregistered.
		enableKnowledge: false,
		enableRelationships: false,
		enableTrajectories: false,
	});
}

describe("useModel: no LLM provider configured", () => {
	it("throws NoModelProviderConfiguredError when no text-generation handler is registered", async () => {
		const runtime = createRuntime();

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		await expect(
			runtime.useModel(ModelType.ACTION_PLANNER, { prompt: "hello" }),
		).rejects.toBeInstanceOf(NoModelProviderConfiguredError);
	});

	it("typed error has stable name and actionable default message", async () => {
		const runtime = createRuntime();

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		try {
			await runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" });
			throw new Error("expected useModel to throw");
		} catch (error) {
			expect(error).toBeInstanceOf(NoModelProviderConfiguredError);
			expect((error as Error).name).toBe("NoModelProviderConfiguredError");
			expect((error as Error).message).toContain("ANTHROPIC_API_KEY");
			expect((error as Error).message).toContain("ELIZAOS_CLOUD_API_KEY");
		}
	});

	it("falls back to generic error when at least one text handler is registered but the requested type is not", async () => {
		const runtime = createRuntime();

		await runtime.initialize({
			allowNoDatabase: true,
			skipMigrations: true,
		});

		// Register only TEXT_SMALL — leave the rest of the chain unregistered.
		// The fallback chain for IMAGE_DESCRIPTION does not include text models,
		// so the request still fails — but with the generic delegate error,
		// because at least one text-generation handler is configured.
		runtime.registerModel(
			ModelType.TEXT_SMALL,
			async () => "ok",
			"test-provider",
		);

		await expect(
			runtime.useModel(ModelType.IMAGE_DESCRIPTION, { prompt: "x" }),
		).rejects.toThrow(/No handler found for delegate type/);
	});
});
