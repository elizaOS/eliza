/**
 * Exercises AgentRuntime service startup, rollback, ownership, and per-class
 * health against the real in-memory adapter.
 */

import { afterEach, describe, expect, it } from "vitest";
import { createCharacter } from "./character.ts";
import { InMemoryDatabaseAdapter } from "./database/inMemoryAdapter.ts";
import { AgentRuntime } from "./runtime.ts";
import type { IAgentRuntime } from "./types/runtime.ts";
import { Service } from "./types/service.ts";

const FAILURE_TYPE = "integration_failure_service";
const MULTI_TYPE = "multi_implementation_service";
const FINALIZATION_TYPE = "finalization_failure_service";
let finalizationStopCalls = 0;
let workingStopCalls = 0;

class FailingService extends Service {
	static override readonly serviceType = FAILURE_TYPE;
	override capabilityDescription = "Fails deterministically during startup.";
	static override async start(): Promise<FailingService> {
		throw new Error("fresh boot dependency is unavailable");
	}
	override async stop(): Promise<void> {}
}

class FailingMultipleService extends Service {
	static override readonly serviceType = MULTI_TYPE;
	static override readonly allowsMultiple = true;
	override capabilityDescription = "The unavailable implementation.";
	static override async start(): Promise<FailingMultipleService> {
		throw new Error("first implementation unavailable");
	}
	override async stop(): Promise<void> {}
}

class WorkingMultipleService extends Service {
	static override readonly serviceType = MULTI_TYPE;
	static override readonly allowsMultiple = true;
	override capabilityDescription = "The available implementation.";
	static override async start(
		runtime: IAgentRuntime,
	): Promise<WorkingMultipleService> {
		return new WorkingMultipleService(runtime);
	}
	override async stop(): Promise<void> {
		workingStopCalls += 1;
	}
}

class LaterWorkingMultipleService extends Service {
	static override readonly serviceType = MULTI_TYPE;
	static override readonly allowsMultiple = true;
	override capabilityDescription =
		"A late, independently started implementation.";
	static override async start(
		runtime: IAgentRuntime,
	): Promise<LaterWorkingMultipleService> {
		return new LaterWorkingMultipleService(runtime);
	}
	override async stop(): Promise<void> {}
}

class FinalizationFailingService extends Service {
	static override readonly serviceType = FINALIZATION_TYPE;
	override capabilityDescription = "Fails while registering send handlers.";
	static override async start(
		runtime: IAgentRuntime,
	): Promise<FinalizationFailingService> {
		return new FinalizationFailingService(runtime);
	}
	static override registerSendHandlers(runtime: IAgentRuntime): void {
		runtime.registerSendHandler("partial-finalization", async () => undefined);
		throw new Error("send-handler finalization failed");
	}
	override async stop(): Promise<void> {
		finalizationStopCalls += 1;
	}
}

describe("AgentRuntime service startup observability", () => {
	const runtimes: AgentRuntime[] = [];

	afterEach(async () => {
		for (const runtime of runtimes.splice(0)) {
			await runtime.stop();
			await runtime.close();
		}
	});

	function runtime(name: string): AgentRuntime {
		const instance = new AgentRuntime({
			character: createCharacter({ name }),
			adapter: new InMemoryDatabaseAdapter(),
			logLevel: "fatal",
		});
		runtimes.push(instance);
		return instance;
	}

	it("reports a typed, plugin-attributed failure", async () => {
		const instance = runtime("ServiceFailureIntegration");
		await instance.initialize();
		await instance.registerPlugin({
			name: "service-failure-integration-plugin",
			description: "Registers a service whose real start method fails.",
			services: [FailingService],
		});

		await expect(
			instance.getServiceLoadPromise(FAILURE_TYPE),
		).rejects.toMatchObject({
			code: "SERVICE_START_FAILED",
			message: "fresh boot dependency is unavailable",
		});
		expect(instance.getServiceHealth()[FAILURE_TYPE]).toMatchObject({
			status: "failed",
			instances: 0,
			implementations: [
				{
					serviceClass: "FailingService",
					plugin: "service-failure-integration-plugin",
					status: "failed",
					error: {
						code: "SERVICE_START_FAILED",
						message: "fresh boot dependency is unavailable",
					},
				},
			],
		});
		expect(instance.getRecentReportedErrors()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					scope: "AgentRuntime.serviceStart",
					context: expect.objectContaining({
						plugin: "service-failure-integration-plugin",
						serviceType: FAILURE_TYPE,
						serviceClass: "FailingService",
					}),
				}),
			]),
		);
	});

	it("retains a failed sibling when another implementation succeeds", async () => {
		const instance = runtime("MultiServiceIntegration");
		await instance.initialize();
		await instance.registerPlugin({
			name: "multi-service-integration-plugin",
			description: "Registers unavailable and available implementations.",
			services: [FailingMultipleService, WorkingMultipleService],
		});

		await expect(
			instance.getServiceLoadPromise(MULTI_TYPE),
		).resolves.toBeInstanceOf(WorkingMultipleService);
		expect(instance.getServiceRegistrationStatus(MULTI_TYPE)).toBe(
			"registered",
		);
		expect(instance.getServiceHealth()[MULTI_TYPE]).toMatchObject({
			status: "degraded",
			instances: 1,
			implementations: expect.arrayContaining([
				expect.objectContaining({
					serviceClass: "FailingMultipleService",
					status: "failed",
				}),
				expect.objectContaining({
					serviceClass: "WorkingMultipleService",
					status: "registered",
				}),
			]),
		});
	});

	it("starts a late implementation even when the type already has an instance", async () => {
		const instance = runtime("LateMultiServiceIntegration");
		await instance.initialize();
		await instance.registerPlugin({
			name: "first-multi-service-plugin",
			description: "Registers the first implementation.",
			services: [WorkingMultipleService],
		});
		await expect(
			instance.getServiceLoadPromise(MULTI_TYPE),
		).resolves.toBeInstanceOf(WorkingMultipleService);

		await instance.registerPlugin({
			name: "later-multi-service-plugin",
			description: "Registers the later implementation.",
			services: [LaterWorkingMultipleService],
		});
		await expect(
			instance.getServiceLoadPromise(MULTI_TYPE),
		).resolves.toBeInstanceOf(WorkingMultipleService);
		expect(instance.getServicesByType(MULTI_TYPE)).toHaveLength(2);
		expect(instance.getServiceHealth()[MULTI_TYPE]).toMatchObject({
			status: "registered",
			instances: 2,
		});
	});

	it("unloading a failed implementation does not stop a healthy sibling", async () => {
		workingStopCalls = 0;
		const instance = runtime("MultiServiceUnloadIntegration");
		await instance.initialize();
		await instance.registerPlugin({
			name: "failing-multi-service-plugin",
			description: "Registers the unavailable implementation.",
			services: [FailingMultipleService],
		});
		await expect(
			instance.getServiceLoadPromise(MULTI_TYPE),
		).rejects.toMatchObject({ code: "SERVICE_START_FAILED" });
		await instance.registerPlugin({
			name: "working-multi-service-plugin",
			description: "Registers the available implementation.",
			services: [WorkingMultipleService],
		});
		await expect(
			instance.getServiceLoadPromise(MULTI_TYPE),
		).resolves.toBeInstanceOf(WorkingMultipleService);

		await instance.unloadPlugin("failing-multi-service-plugin");
		expect(workingStopCalls).toBe(0);
		expect(instance.getService(MULTI_TYPE)).toBeInstanceOf(
			WorkingMultipleService,
		);
		expect(instance.getServiceHealth()[MULTI_TYPE]).toMatchObject({
			status: "registered",
			instances: 1,
			implementations: [
				expect.objectContaining({
					serviceClass: "WorkingMultipleService",
					status: "registered",
				}),
			],
		});
	});

	it("rolls back a service whose send-handler finalization fails", async () => {
		finalizationStopCalls = 0;
		let originalSendCalls = 0;
		const instance = runtime("ServiceFinalizationIntegration");
		await instance.initialize();
		instance.registerSendHandler("partial-finalization", async () => {
			originalSendCalls += 1;
			return undefined;
		});
		await instance.registerPlugin({
			name: "service-finalization-integration-plugin",
			description: "Registers a service with a failing finalization hook.",
			services: [FinalizationFailingService],
		});

		await expect(
			instance.getServiceLoadPromise(FINALIZATION_TYPE),
		).rejects.toMatchObject({
			code: "SERVICE_START_FAILED",
			message: "send-handler finalization failed",
		});
		expect(instance.getService(FINALIZATION_TYPE)).toBeNull();
		await instance.sendMessageToTarget(
			{ source: "partial-finalization" },
			{ text: "restored handler", agentVoiced: true },
		);
		expect(originalSendCalls).toBe(1);
		expect(finalizationStopCalls).toBe(1);
	});
});
