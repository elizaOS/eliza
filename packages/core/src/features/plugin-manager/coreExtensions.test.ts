/**
 * Unit coverage for the plugin-manager runtime extensions, using real registry
 * arrays and service maps to verify component removal and shutdown behavior.
 */

import { describe, expect, it } from "vitest";
import { createMockRuntime } from "../../testing/mock-runtime.ts";
import type { Action, Provider } from "../../types/components.ts";
import type { IAgentRuntime } from "../../types/runtime.ts";
import { Service, type ServiceTypeName } from "../../types/service.ts";
import {
	applyRuntimeExtensions,
	type ExtendedRuntime,
	extendRuntimeWithComponentUnregistration,
} from "./coreExtensions.ts";

function createAction(name: string): Action {
	return {
		name,
		description: `${name} action`,
		validate: async () => true,
		handler: async () => undefined,
	};
}

function createProvider(name: string): Provider {
	return {
		name,
		get: async () => ({ text: name }),
	};
}

class RecordingService extends Service {
	readonly capabilityDescription: string;

	constructor(
		private readonly label: string,
		private readonly stops: string[],
		private readonly failure?: Error,
	) {
		super();
		this.capabilityDescription = `${label} service`;
	}

	async stop(): Promise<void> {
		this.stops.push(this.label);
		if (this.failure) throw this.failure;
	}
}

function createRuntimeWithServices(
	services: Map<ServiceTypeName, Service[]>,
): IAgentRuntime {
	return createMockRuntime({
		services,
		getServicesByType: <T extends Service>(serviceType: string) =>
			(services.get(serviceType as ServiceTypeName) ?? []) as T[],
		getAllServices: () => services,
	});
}

describe("core runtime component unregistration extensions", () => {
	it("applies all missing component unregistration methods", () => {
		const runtime = createMockRuntime();

		applyRuntimeExtensions(runtime);

		const extended = runtime as ExtendedRuntime;
		expect(extended.unregisterAction).toBeTypeOf("function");
		expect(extended.unregisterProvider).toBeTypeOf("function");
		expect(extended.unregisterService).toBeTypeOf("function");
	});

	it("preserves component unregistration methods already supplied by the runtime", () => {
		const unregisterAction = () => false;
		const unregisterProvider = () => undefined;
		const unregisterService = async () => undefined;
		const runtime = createMockRuntime({ unregisterAction }) as ExtendedRuntime;
		runtime.unregisterProvider = unregisterProvider;
		runtime.unregisterService = unregisterService;

		extendRuntimeWithComponentUnregistration(runtime);

		expect(runtime.unregisterAction).toBe(unregisterAction);
		expect(runtime.unregisterProvider).toBe(unregisterProvider);
		expect(runtime.unregisterService).toBe(unregisterService);
	});

	it("removes only the first action with a matching name and reports whether it found one", () => {
		const first = createAction("duplicate");
		const second = createAction("duplicate");
		const untouched = createAction("untouched");
		const runtime = createMockRuntime({ actions: [first, untouched, second] });
		extendRuntimeWithComponentUnregistration(runtime);

		expect(runtime.unregisterAction("duplicate")).toBe(true);
		expect(runtime.actions).toEqual([untouched, second]);
		expect(runtime.unregisterAction("missing")).toBe(false);
		expect(runtime.actions).toEqual([untouched, second]);
	});

	it("removes only the first matching provider and leaves the array unchanged for a missing name", () => {
		const first = createProvider("duplicate");
		const second = createProvider("duplicate");
		const untouched = createProvider("untouched");
		const runtime = createMockRuntime({
			providers: [first, untouched, second],
		}) as ExtendedRuntime;
		extendRuntimeWithComponentUnregistration(runtime);

		runtime.unregisterProvider?.("duplicate");
		expect(runtime.providers).toEqual([untouched, second]);
		runtime.unregisterProvider?.("missing");
		expect(runtime.providers).toEqual([untouched, second]);
	});

	it("does not alter the service map when the requested type has no services", async () => {
		const services = new Map<ServiceTypeName, Service[]>([["unknown", []]]);
		const runtime = createRuntimeWithServices(services) as ExtendedRuntime;
		extendRuntimeWithComponentUnregistration(runtime);

		await runtime.unregisterService?.("unknown");

		expect(services.has("unknown")).toBe(true);
	});

	it("stops every service in registration order before deleting its service type", async () => {
		const stops: string[] = [];
		const services = new Map<ServiceTypeName, Service[]>([
			[
				"unknown",
				[
					new RecordingService("first", stops),
					new RecordingService("second", stops),
				],
			],
		]);
		const runtime = createRuntimeWithServices(services) as ExtendedRuntime;
		extendRuntimeWithComponentUnregistration(runtime);

		await runtime.unregisterService?.("unknown");

		expect(stops).toEqual(["first", "second"]);
		expect(services.has("unknown")).toBe(false);
	});

	it("keeps the service registration when shutdown fails", async () => {
		const stops: string[] = [];
		const failure = new Error("stop failed");
		const services = new Map<ServiceTypeName, Service[]>([
			[
				"unknown",
				[
					new RecordingService("first", stops),
					new RecordingService("failing", stops, failure),
					new RecordingService("not-reached", stops),
				],
			],
		]);
		const runtime = createRuntimeWithServices(services) as ExtendedRuntime;
		extendRuntimeWithComponentUnregistration(runtime);

		await expect(runtime.unregisterService?.("unknown")).rejects.toBe(failure);

		expect(stops).toEqual(["first", "failing"]);
		expect(services.has("unknown")).toBe(true);
	});
});
