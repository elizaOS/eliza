import { describe, expect, it } from "vitest";
import { createService, defineService } from "../services.ts";
import { Service } from "../types/service.ts";

describe("ServiceBuilder", () => {
	it("builds a Service subclass with pinned static serviceType", () => {
		const Built = createService("my_service").build();
		expect(Built.serviceType).toBe("my_service");
		// Static member is non-writable and non-configurable.
		expect(Object.getOwnPropertyDescriptor(Built, "serviceType")).toMatchObject(
			{
				writable: false,
				enumerable: true,
				configurable: false,
			},
		);
	});

	it("exposes the configured capability description on instances", () => {
		const Built = createService("desc_service")
			.withDescription("does a thing")
			.build();
		const instance = new Built({} as never);
		expect(instance.capabilityDescription).toBe("does a thing");
	});

	it("returns a fresh class per build call", () => {
		const builder = createService("fresh_service");
		expect(builder.build()).not.toBe(builder.build());
	});

	it("runs the configured start function with the runtime", async () => {
		const started: unknown[] = [];
		const Built = createService("start_service")
			.withStart(async (runtime) => {
				started.push(runtime);
				return new Built({} as never);
			})
			.build();
		const runtime = { id: "r1" };
		const result = await Built.start(runtime as never);
		expect(started).toEqual([runtime]);
		expect(result).toBeInstanceOf(Built);
	});

	it("throws when start is called without a configured start function", async () => {
		const Built = createService("no_start_service").build();
		await expect(Built.start({} as never)).rejects.toThrow(
			"Start function not defined for service no_start_service",
		);
	});

	it("invokes the configured stop function on stop", async () => {
		let stopped = 0;
		const Built = createService("stop_service")
			.withStop(async () => {
				stopped += 1;
			})
			.build();
		const instance = new Built({} as never);
		await instance.stop();
		expect(stopped).toBe(1);
	});

	it("resolves stop when no stop function is configured", async () => {
		const Built = createService("no_stop_service").build();
		const instance = new Built({} as never);
		await expect(instance.stop()).resolves.toBeUndefined();
	});
});

describe("defineService", () => {
	it("wires description, start, and stop from a definition object", async () => {
		const started: unknown[] = [];
		const Defined = defineService({
			serviceType: "defined_service",
			description: "defined description",
			start: async (runtime) => {
				started.push(runtime);
				return new Defined({} as never);
			},
			stop: async () => {},
		});
		expect(Defined.serviceType).toBe("defined_service");
		const instance = new Defined({} as never);
		expect(instance.capabilityDescription).toBe("defined description");
		await Defined.start({ id: "d1" } as never);
		expect(started).toEqual([{ id: "d1" }]);
		await expect(instance.stop()).resolves.toBeUndefined();
	});

	it("provides a no-op stop when the definition omits it", async () => {
		const Defined = defineService({
			serviceType: "defined_no_stop",
			description: "",
			start: async () => new Defined({} as never),
		});
		const instance = new Defined({} as never);
		await expect(instance.stop()).resolves.toBeUndefined();
	});
});

describe("ServiceBuilder type surface", () => {
	it("returns a TypedServiceBuilder whose instances extend Service", () => {
		const Built = createService("typed_service")
			.withStart(async () => new Built({} as never))
			.build();
		const instance = new Built({} as never);
		expect(instance).toBeInstanceOf(Service);
		expect(typeof Built.start).toBe("function");
		expect(typeof instance.stop).toBe("function");
	});
});
