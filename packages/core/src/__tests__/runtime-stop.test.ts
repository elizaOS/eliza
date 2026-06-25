import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryDatabaseAdapter } from "../database/inMemoryAdapter";
import { AgentRuntime } from "../runtime";
import { type Character, Service } from "../types";

class SlowStopService extends Service {
	static override serviceType = "slow-stop";
	override capabilityDescription = "test service";

	static override async start(): Promise<SlowStopService> {
		return new SlowStopService();
	}

	override async stop(): Promise<void> {
		await new Promise((resolve) => setTimeout(resolve, 10_000));
	}
}

function makeRuntime(): AgentRuntime {
	return new AgentRuntime({
		character: {
			name: "runtime-stop-test",
			bio: "test",
			settings: {},
		} as Character,
		adapter: new InMemoryDatabaseAdapter(),
		logLevel: "fatal",
	});
}

describe("AgentRuntime.stop", () => {
	const previousFastShutdown = process.env.ELIZA_FAST_SHUTDOWN;

	afterEach(() => {
		if (previousFastShutdown === undefined) {
			delete process.env.ELIZA_FAST_SHUTDOWN;
		} else {
			process.env.ELIZA_FAST_SHUTDOWN = previousFastShutdown;
		}
	});

	it("fast mode skips unresolved service starts and caps service stop waits", async () => {
		const runtime = makeRuntime();
		const stopSpy = vi.spyOn(SlowStopService.prototype, "stop");
		// biome-ignore lint/suspicious/noExplicitAny: inject internal service state to isolate stop behavior
		(runtime as any).startingServices.set(
			"never-starts",
			new Promise(() => {}),
		);
		// biome-ignore lint/suspicious/noExplicitAny: inject internal service state to isolate stop behavior
		(runtime as any).services.set("slow-stop", [new SlowStopService()]);

		const startedAt = Date.now();
		await runtime.stop({ fast: true });

		expect(Date.now() - startedAt).toBeLessThan(2_000);
		expect(stopSpy).toHaveBeenCalledTimes(1);
		// biome-ignore lint/suspicious/noExplicitAny: verify in-flight starts were cleared
		expect((runtime as any).startingServices.size).toBe(0);
		expect(process.env.ELIZA_FAST_SHUTDOWN).toBeUndefined();
	});
});
