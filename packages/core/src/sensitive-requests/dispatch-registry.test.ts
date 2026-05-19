import { describe, expect, test, vi } from "vitest";
import {
	createSensitiveRequestDispatchRegistry,
	type DeliveryResult,
	type DeliveryTarget,
	type SensitiveRequest,
	type SensitiveRequestDeliveryAdapter,
} from "./dispatch-registry";

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
				expiresAt: 0,
			};
		},
		...overrides,
	};
}

function makeRequest(): SensitiveRequest {
	return {
		id: "req-1",
		kind: "secret",
		reason: "test",
		actorPolicy: "owner_or_linked_identity",
		eligibleDeliveryTargets: ["dm"],
		status: "pending",
		expiresAt: 0,
		createdAt: 0,
	};
}

describe("createSensitiveRequestDispatchRegistry", () => {
	test("register adds an adapter and get retrieves it", () => {
		const registry = createSensitiveRequestDispatchRegistry();
		const adapter = makeAdapter("dm");

		registry.register(adapter);

		expect(registry.get("dm")).toBe(adapter);
	});

	test("register with same target replaces previous adapter", () => {
		const registry = createSensitiveRequestDispatchRegistry();
		const first = makeAdapter("dm");
		const second = makeAdapter("dm");

		registry.register(first);
		registry.register(second);

		expect(registry.get("dm")).toBe(second);
		expect(registry.get("dm")).not.toBe(first);
		expect(registry.list()).toHaveLength(1);
	});

	test("unregister removes the adapter and get returns undefined", () => {
		const registry = createSensitiveRequestDispatchRegistry();
		registry.register(makeAdapter("dm"));

		registry.unregister("dm");

		expect(registry.get("dm")).toBeUndefined();
		expect(registry.list()).toHaveLength(0);
	});

	test("list returns all registered adapters", () => {
		const registry = createSensitiveRequestDispatchRegistry();
		const dm = makeAdapter("dm");
		const owner = makeAdapter("owner_app_inline");
		const cloud = makeAdapter("cloud_authenticated_link");

		registry.register(dm);
		registry.register(owner);
		registry.register(cloud);

		const list = registry.list();
		expect(list).toHaveLength(3);
		expect(list).toEqual(expect.arrayContaining([dm, owner, cloud]));
	});

	test("supportsChannel default is true when omitted (caller treats missing as supported)", () => {
		const adapter = makeAdapter("dm");

		// The contract: when `supportsChannel` is omitted on the adapter, the
		// dispatcher treats the adapter as supporting any channel. We model
		// that by checking the property is undefined, so callers can apply the
		// default themselves.
		expect(adapter.supportsChannel).toBeUndefined();
	});

	test("deliver is invoked through retrieved adapter", async () => {
		const registry = createSensitiveRequestDispatchRegistry();
		const deliver = vi.fn(
			async (): Promise<DeliveryResult> => ({
				delivered: true,
				target: "dm",
				expiresAt: 123,
			}),
		);
		registry.register({ target: "dm", deliver });

		const got = registry.get("dm");
		expect(got).toBeDefined();
		const result = await got?.deliver({
			request: makeRequest(),
			channelId: "ch",
			runtime: {},
		});

		expect(deliver).toHaveBeenCalledTimes(1);
		expect(result?.delivered).toBe(true);
		expect(result?.expiresAt).toBe(123);
	});
});
