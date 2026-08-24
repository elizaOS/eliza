/**
 * Exercises the sensitive-requests public barrel (`./index`) — the
 * dispatch-registry re-export wiring plus the registry and service behavior
 * reachable only through it: empty-registry results, omitted-`supportsChannel`
 * resolution, argument forwarding, unknown-target unregister, exact listing
 * order, and the service start / delegate / stop lifecycle — over
 * deterministic fake adapters with no real connector delivery.
 */
import { describe, expect, test } from "vitest";
import {
	createSensitiveRequestDispatchRegistry,
	type DeliveryResult,
	type DeliveryTarget,
	SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
	type SensitiveRequestDeliveryAdapter,
	SensitiveRequestDispatchRegistryService,
} from "./index";

function makeAdapter(
	target: DeliveryTarget,
	overrides: Partial<SensitiveRequestDeliveryAdapter> = {},
): SensitiveRequestDeliveryAdapter {
	return {
		target,
		async deliver(): Promise<DeliveryResult> {
			return {
				delivered: true,
				target,
			};
		},
		...overrides,
	};
}

describe("createSensitiveRequestDispatchRegistry (barrel export)", () => {
	test("the barrel exposes a callable factory returning a full registry", () => {
		expect(typeof createSensitiveRequestDispatchRegistry).toBe("function");

		const registry = createSensitiveRequestDispatchRegistry();
		expect(typeof registry.register).toBe("function");
		expect(typeof registry.unregister).toBe("function");
		expect(typeof registry.get).toBe("function");
		expect(typeof registry.resolve).toBe("function");
		expect(typeof registry.list).toBe("function");
	});

	test("get, list, and resolve are empty before anything registers", () => {
		const registry = createSensitiveRequestDispatchRegistry();

		expect(registry.get("dm")).toBeUndefined();
		expect(registry.list()).toEqual([]);
		expect(registry.resolve?.("dm", "chan-1", {})).toBeUndefined();
	});

	test("resolve treats an omitted supportsChannel as accepting any channel", () => {
		const registry = createSensitiveRequestDispatchRegistry();
		const declines = makeAdapter("dm", { supportsChannel: () => false });
		const silent = makeAdapter("dm");
		registry.register(declines);
		registry.register(silent);

		// An adapter without supportsChannel never vetoes: `!== false` passes it.
		expect(registry.resolve?.("dm", "chan-1", {})).toBe(silent);
	});

	test("resolve forwards the requested channel and runtime to supportsChannel", () => {
		const registry = createSensitiveRequestDispatchRegistry();
		let seenChannelId: string | undefined;
		let seenRuntime: unknown;
		const observer = makeAdapter("dm", {
			supportsChannel(channelId, runtime) {
				seenChannelId = channelId;
				seenRuntime = runtime;
				return true;
			},
		});
		registry.register(observer);

		const runtimeMarker = { agentId: "agent-1" };
		const resolved = registry.resolve?.("dm", "chan-42", runtimeMarker);

		expect(resolved).toBe(observer);
		expect(seenChannelId).toBe("chan-42");
		expect(seenRuntime).toBe(runtimeMarker);
	});

	test("unregistering an unknown target is a no-op that keeps later registration intact", () => {
		const registry = createSensitiveRequestDispatchRegistry();

		expect(() => registry.unregister("public_link")).not.toThrow();

		const adapter = makeAdapter("dm");
		registry.register(adapter);
		expect(registry.get("dm")).toBe(adapter);
		expect(registry.list()).toEqual([adapter]);
	});

	test("list keeps each target at its first-insertion position and appends within it", () => {
		const registry = createSensitiveRequestDispatchRegistry();
		const dmFirst = makeAdapter("dm");
		const ownerApp = makeAdapter("owner_app_inline");
		const dmSecond = makeAdapter("dm");

		registry.register(dmFirst);
		registry.register(ownerApp);
		registry.register(dmSecond);

		// Re-registering "dm" does not move the group: the backing Map keeps
		// the target's original insertion slot, so dmSecond lands inside the
		// existing "dm" group rather than after owner_app_inline.
		expect(registry.list()).toEqual([dmFirst, dmSecond, ownerApp]);
	});
});

describe("SensitiveRequestDispatchRegistryService (barrel export)", () => {
	test("exposes the service class wired to the shared service-name constant", () => {
		expect(typeof SensitiveRequestDispatchRegistryService).toBe("function");
		expect(SensitiveRequestDispatchRegistryService.serviceType).toBe(
			SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE,
		);
		expect(SENSITIVE_REQUEST_DISPATCH_REGISTRY_SERVICE).toBe(
			"SensitiveRequestDispatchRegistry",
		);
	});

	test("start yields a usable registry instance", async () => {
		const service = await SensitiveRequestDispatchRegistryService.start(
			{} as never,
		);

		expect(service instanceof SensitiveRequestDispatchRegistryService).toBe(
			true,
		);

		const adapter = makeAdapter("dm");
		service.register(adapter);
		expect(service.get("dm")).toBe(adapter);
		expect(service.list()).toEqual([adapter]);
	});

	test("register, get, resolve, and list delegate to the internal registry", async () => {
		const service = await SensitiveRequestDispatchRegistryService.start(
			{} as never,
		);
		const declines = makeAdapter("dm", { supportsChannel: () => false });
		const silent = makeAdapter("dm");
		service.register(declines);
		service.register(silent);

		expect(service.get("dm")).toBe(silent);
		expect(service.resolve("dm", "chan-7", null)).toBe(silent);
		expect(service.list()).toHaveLength(2);
	});

	test("stop unregisters every target yet leaves the service reusable", async () => {
		const service = await SensitiveRequestDispatchRegistryService.start(
			{} as never,
		);
		service.register(makeAdapter("dm"));
		service.register(makeAdapter("owner_app_inline"));

		await service.stop();

		expect(service.get("dm")).toBeUndefined();
		expect(service.get("owner_app_inline")).toBeUndefined();
		expect(service.list()).toHaveLength(0);

		const replacement = makeAdapter("tunnel_authenticated_link");
		service.register(replacement);
		expect(service.get("tunnel_authenticated_link")).toBe(replacement);
	});
});
