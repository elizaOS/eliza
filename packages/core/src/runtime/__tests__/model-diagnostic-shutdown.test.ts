import { describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../../database/inMemoryAdapter";
import { AgentRuntime } from "../../runtime";
import { ModelType } from "../../types";

function fixture() {
	const adapter = new InMemoryDatabaseAdapter();
	const runtime = new AgentRuntime({
		character: { name: "DiagnosticShutdown", bio: "test" },
		adapter,
		logLevel: "fatal",
	});
	runtime.registerModel(ModelType.TEXT_LARGE, async () => "answer", "fixture");
	return { runtime, adapter };
}

describe("model diagnostic ownership", () => {
	it.each(["stop", "close"] as const)(
		"%s waits for a pending log without delaying the response",
		async (operation) => {
			const { runtime, adapter } = fixture();
			const write = Promise.withResolvers<void>();
			const persist = adapter.createLogs.bind(adapter);
			const events: string[] = [];
			vi.spyOn(adapter, "createLogs").mockImplementation(async (logs) => {
				await write.promise;
				await persist(logs);
				events.push("persisted");
			});
			vi.spyOn(adapter, "close").mockImplementation(async () => {
				events.push("closed");
			});
			await expect(
				runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
			).resolves.toBe("answer");
			const shutdown = runtime[operation]().then(() => events.push("finished"));
			await Promise.resolve();
			expect(events).toEqual([]);
			write.resolve();
			await shutdown;
			expect(events).toEqual(
				operation === "close"
					? ["persisted", "closed", "finished"]
					: ["persisted", "finished"],
			);
			if (operation === "stop") await runtime.close();
		},
	);

	it("reports a failed log without changing the model result or preventing close", async () => {
		const { runtime, adapter } = fixture();
		const write = Promise.withResolvers<void>();
		vi.spyOn(adapter, "createLogs").mockImplementation(() => write.promise);
		const report = vi.spyOn(runtime, "reportError");
		const close = vi.spyOn(adapter, "close");
		await expect(
			runtime.useModel(ModelType.TEXT_LARGE, { prompt: "hello" }),
		).resolves.toBe("answer");
		const shutdown = runtime.close();
		const failure = new Error("diagnostic storage unavailable");
		write.reject(failure);
		await shutdown;
		expect(close).toHaveBeenCalledOnce();
		expect(report).toHaveBeenCalledWith("AgentRuntime.modelCallLog", failure, {
			model: "TEXT_LARGE",
			diagnosticOnly: true,
		});
	});
});
