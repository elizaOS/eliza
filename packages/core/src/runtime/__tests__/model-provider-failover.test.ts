/**
 * Exercises `AgentRuntime.useModel` provider failover: an exhausted
 * (rate-limited) provider falls through to the next registration, an
 * `ELIZA_BRAIN_PROVIDER` pin is preferred yet still failed past when limited,
 * and neither ordinary errors nor an explicitly requested provider trigger
 * failover. A real runtime over the in-memory adapter drives stub handlers that
 * throw the live subscription-limit envelope — no network model call.
 */
import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { type Character, ModelType } from "../../types";

function makeRuntime(settings: Record<string, string> = {}): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "ProviderFailoverAgent",
			bio: "test",
			settings,
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

/** The exact subscription-limit error the cli-inference SDK session throws live. */
const CLI_INFERENCE_LIMIT_ERROR =
	"[cli-inference:sdk] subscription rate limit reached: You've hit your session limit · resets 9:30pm (UTC)";

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

	it("fails over past an ELIZA_BRAIN_PROVIDER override when it is rate-limited", async () => {
		// The owner pinned the chat brain to the subscription CLI route. When that
		// provider throws its limit envelope the pin must NOT strand the brain —
		// the remaining registered providers are the backup tier (#10893).
		const runtime = makeRuntime({ ELIZA_BRAIN_PROVIDER: "cli-inference" });
		const exhaustedHandler = vi.fn(async () => {
			throw new Error(CLI_INFERENCE_LIMIT_ERROR);
		});
		const backupHandler = vi.fn(async () => "backup response");

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			exhaustedHandler,
			"cli-inference",
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

	it("still prefers the ELIZA_BRAIN_PROVIDER override when it is healthy", async () => {
		const runtime = makeRuntime({ ELIZA_BRAIN_PROVIDER: "cli-inference" });
		const pinnedHandler = vi.fn(async () => "pinned response");
		const backupHandler = vi.fn(async () => "backup response");

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			pinnedHandler,
			"cli-inference",
			10,
		);
		runtime.registerModel(
			ModelType.TEXT_LARGE,
			backupHandler,
			"elizacloud",
			100,
		);

		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).resolves.toBe("pinned response");
		expect(pinnedHandler).toHaveBeenCalledTimes(1);
		expect(backupHandler).not.toHaveBeenCalled();
	});

	it("does not fail over past a rate-limited override on ordinary errors", async () => {
		const runtime = makeRuntime({ ELIZA_BRAIN_PROVIDER: "cli-inference" });
		const failingHandler = vi.fn(async () => {
			throw new Error("invalid request payload");
		});
		const backupHandler = vi.fn(async () => "backup response");

		runtime.registerModel(
			ModelType.TEXT_LARGE,
			failingHandler,
			"cli-inference",
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

	it("fails over RESPONSE_HANDLER to the backup provider on a subscription limit", async () => {
		// RESPONSE_HANDLER is the user-facing reply tier the cli-inference route
		// serves; the exact live limit throw must reach the backup registration.
		const runtime = makeRuntime();
		const exhaustedHandler = vi.fn(async () => {
			throw new Error(CLI_INFERENCE_LIMIT_ERROR);
		});
		const backupHandler = vi.fn(async () => "backup response");

		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			exhaustedHandler,
			"cli-inference",
			100,
		);
		runtime.registerModel(
			ModelType.RESPONSE_HANDLER,
			backupHandler,
			"elizacloud",
			10,
		);

		await expect(
			runtime.useModel(ModelType.RESPONSE_HANDLER, { prompt: "hello" }),
		).resolves.toBe("backup response");
		expect(exhaustedHandler).toHaveBeenCalledTimes(1);
		expect(backupHandler).toHaveBeenCalledTimes(1);
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
