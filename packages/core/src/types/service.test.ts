/**
 * Service abstraction contracts: error normalization, the abstract `Service`
 * base class lifecycle, the canonical `ServiceType` registry strings, and
 * typed service lookup delegation. Deterministic tests driving the real
 * module with no network or model substitutes.
 */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime } from "./runtime";
import {
	createServiceError,
	getTypedService,
	Service,
	ServiceType,
} from "./service";

class EchoService extends Service {
	static override serviceType = ServiceType.UNKNOWN;

	override get capabilityDescription(): string {
		return "echo service for contract tests";
	}

	runtimeRef(): unknown {
		return this.runtime;
	}

	async stop(): Promise<void> {}
}

class BootedService extends EchoService {
	static override async start(runtime: IAgentRuntime): Promise<Service> {
		return new BootedService(runtime);
	}
}

describe("createServiceError", () => {
	it("wraps an Error instance with its message and preserves it as cause", () => {
		const original = new Error("connection reset");
		const normalized = createServiceError(original, "TRANSPORT_RESET");

		expect(normalized.code).toBe("TRANSPORT_RESET");
		expect(normalized.message).toBe("connection reset");
		expect(normalized.cause).toBe(original);
	});

	it("defaults the code to UNKNOWN_ERROR for Error and string inputs", () => {
		expect(createServiceError(new Error("boom")).code).toBe("UNKNOWN_ERROR");
		expect(createServiceError("boom").code).toBe("UNKNOWN_ERROR");
	});

	it("coerces a plain string into the message without inventing a cause", () => {
		const normalized = createServiceError("disk full", "STORAGE_FULL");

		expect(normalized).toEqual({ code: "STORAGE_FULL", message: "disk full" });
		expect(Object.hasOwn(normalized, "cause")).toBe(false);
	});

	it.each([
		[42, "42"],
		[true, "true"],
		[null, "null"],
	])(
		"stringifies a non-string value %s into the message",
		(value, expected) => {
			expect(createServiceError(value, "VALUE_RENDER").message).toBe(expected);
		},
	);
});

describe("Service base class", () => {
	it("fails fast when a subclass does not implement start()", async () => {
		await expect(Service.start({} as IAgentRuntime)).rejects.toThrow(
			"Service.start() must be implemented by subclass",
		);
	});

	it("lets an overriding subclass start and hands back a live instance", async () => {
		const runtimeStub = { getService: () => null } as IAgentRuntime;

		const started = await BootedService.start(runtimeStub);

		expect(started).toBeInstanceOf(BootedService);
		expect(started).toBeInstanceOf(Service);
	});

	it("stores the provided runtime on the instance", () => {
		const runtimeStub = { getService: () => null } as IAgentRuntime;

		const instance = new EchoService(runtimeStub);

		expect(instance.runtimeRef()).toBe(runtimeStub);
	});

	it("leaves the runtime unset when constructed without one", () => {
		const bare = new EchoService();

		expect(bare.runtimeRef()).toBeUndefined();
	});
});

describe("ServiceType registry strings", () => {
	it("keeps every registered type string distinct so Map-based registration cannot collide", () => {
		const values = Object.values(ServiceType);

		expect(new Set(values).size).toBe(values.length);
	});
});

describe("getTypedService", () => {
	it("forwards the requested service type to the runtime lookup and returns the identical instance", () => {
		const requested: string[] = [];
		const instance = new EchoService();
		const runtimeStub = {
			getService: (serviceType: string) => {
				requested.push(serviceType);
				return instance;
			},
		} as IAgentRuntime;

		const resolved = getTypedService(runtimeStub, ServiceType.MESSAGE_SERVICE);

		expect(requested).toEqual([ServiceType.MESSAGE_SERVICE]);
		expect(resolved).toBe(instance);
	});

	it("returns null when the runtime reports no such service", () => {
		const runtimeStub = { getService: () => null } as IAgentRuntime;

		expect(getTypedService(runtimeStub, ServiceType.VIDEO)).toBeNull();
	});
});
