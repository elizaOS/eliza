import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "ProviderFailoverAgent",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

describe("AgentRuntime.useModel provider failover", () => {
	it("tries the next registered provider when the preferred provider is exhausted", async () => {
		const runtime = makeRuntime();
		const exhaustedHandler = vi.fn(async () => {
			throw new Error("You've hit your session limit for now.");
		});
		const backupHandler = vi.fn(async () => "backup response");

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			exhaustedHandler,
			"claude-sdk",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			backupHandler,
			"elizacloud",
			10,
		);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).resolves.toBe("backup response");
		expect(exhaustedHandler).toHaveBeenCalledTimes(1);
		expect(backupHandler).toHaveBeenCalledTimes(1);
	});

	it("does not fail over on ordinary provider errors", async () => {
		const runtime = makeRuntime();
		const failingHandler = vi.fn(async () => {
			throw new Error("invalid request payload");
		});
		const backupHandler = vi.fn(async () => "backup response");

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			failingHandler,
			"claude-sdk",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			backupHandler,
			"elizacloud",
			10,
		);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).rejects.toThrow("invalid request payload");
		expect(failingHandler).toHaveBeenCalledTimes(1);
		expect(backupHandler).not.toHaveBeenCalled();
	});

	it("does not switch providers when a provider is explicitly requested", async () => {
		const runtime = makeRuntime();
		const exhaustedHandler = vi.fn(async () => {
			throw new Error("session limit reached");
		});
		const backupHandler = vi.fn(async () => "backup response");

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			exhaustedHandler,
			"claude-sdk",
			100,
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			backupHandler,
			"elizacloud",
			10,
		);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }, "claude-sdk"),
		).rejects.toThrow("session limit reached");
		expect(exhaustedHandler).toHaveBeenCalledTimes(1);
		expect(backupHandler).not.toHaveBeenCalled();
	});
});
