/**
 * Eager service startup retries a failed boot-time start with a bounded
 * backoff instead of leaving the service type failed for the process lifetime.
 * Real AgentRuntime with the in-memory adapter; fake timers drive the backoff.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntime } from "../runtime";
import type { IAgentRuntime } from "../types/runtime";
import { Service } from "../types/service";

afterEach(() => {
	vi.useRealTimers();
});

describe("eager service start retry", () => {
	it("starts a service whose first start attempt failed transiently", async () => {
		// Live 2026-09-05: calendar_migration and lifeops_family_communications
		// failed their schema DDL on a saturated pool at boot and stayed failed.
		vi.useFakeTimers();
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let attempts = 0;
		class FlakyService extends Service {
			static override serviceType = "retry-flaky-service";
			capabilityDescription = "service whose first start fails";
			static override async start(
				_runtime: IAgentRuntime,
			): Promise<FlakyService> {
				attempts += 1;
				if (attempts === 1) {
					throw new Error("timeout exceeded when trying to connect");
				}
				return new FlakyService(_runtime);
			}
		}
		await runtime.registerPlugin({
			name: "retry-plugin",
			description: "registers the flaky service",
			services: [FlakyService],
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);
		expect(runtime.getService("retry-flaky-service")).toBeNull();

		await vi.advanceTimersByTimeAsync(2_000);
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(2);
		expect(runtime.getService("retry-flaky-service")).toBeInstanceOf(
			FlakyService,
		);
		expect(runtime.getServiceRegistrationStatus("retry-flaky-service")).toBe(
			"registered",
		);
		await runtime.stop();
	});

	it("stops retrying once the runtime is stopping", async () => {
		vi.useFakeTimers();
		const runtime = new AgentRuntime({ logLevel: "fatal" });
		await runtime.initialize({ allowNoDatabase: true, skipMigrations: true });
		let attempts = 0;
		class AlwaysFailingService extends Service {
			static override serviceType = "retry-always-failing";
			capabilityDescription = "service that never starts";
			static override async start(): Promise<AlwaysFailingService> {
				attempts += 1;
				throw new Error("permanently unavailable");
			}
		}
		await runtime.registerPlugin({
			name: "failing-plugin",
			description: "registers a failing service",
			services: [AlwaysFailingService],
		});
		await vi.advanceTimersByTimeAsync(0);
		expect(attempts).toBe(1);
		await runtime.stop();
		await vi.advanceTimersByTimeAsync(20_000);
		expect(attempts).toBe(1);
	});
});
