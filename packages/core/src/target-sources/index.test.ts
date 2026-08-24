/**
 * Exercises the `./index` barrel for the connector target-source registry:
 * proves its re-exports are the live registry bindings (not dead copies) and
 * drives the factory and service behavior reachable through it — register /
 * get / list / unregister keyed by platform, insertion-order listing, missing
 * keys, replacement, snapshot isolation, and service stop clearing — with
 * deterministic fake sources. No mocks of the subject under test.
 */
import { describe, expect, it } from "vitest";
import {
	CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
	createTargetSourceRegistry,
	type TargetSource,
	TargetSourceRegistryService,
} from "./index";
import {
	createTargetSourceRegistry as createTargetSourceRegistryFromRegistry,
	TargetSourceRegistryService as TargetSourceRegistryServiceFromRegistry,
} from "./registry";

function fakeSource(platform: string): TargetSource {
	return {
		platform,
		async enumerate() {
			return [];
		},
	};
}

describe("target-sources index barrel", () => {
	it("re-exports the live registry bindings", () => {
		expect(CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE).toBe(
			"ConnectorTargetSourceRegistry",
		);
		expect(createTargetSourceRegistry).toBe(
			createTargetSourceRegistryFromRegistry,
		);
		expect(TargetSourceRegistryService).toBe(
			TargetSourceRegistryServiceFromRegistry,
		);
	});
});

describe("createTargetSourceRegistry (via ./index)", () => {
	it("starts empty and round-trips register / get / list / unregister", async () => {
		const reg = createTargetSourceRegistry();
		expect(reg.list()).toEqual([]);

		const discord = fakeSource("discord");
		reg.register(discord);
		const slack = fakeSource("slack");
		reg.register(slack);

		expect(reg.get("discord")).toBe(discord);
		expect(reg.get("slack")).toBe(slack);
		expect(reg.list()).toEqual([discord, slack]);

		reg.unregister("discord");
		expect(reg.get("discord")).toBeUndefined();
		expect(reg.list()).toEqual([slack]);
	});

	it("returns undefined for a platform that was never registered", () => {
		const reg = createTargetSourceRegistry();
		expect(reg.get("telegram")).toBeUndefined();
	});

	it("unregistering a missing platform is a no-op", () => {
		const reg = createTargetSourceRegistry();
		const discord = fakeSource("discord");
		reg.register(discord);

		expect(() => reg.unregister("gmail")).not.toThrow();
		expect(reg.list()).toEqual([discord]);
	});

	it("keys by platform — re-registering replaces the prior source", async () => {
		const reg = createTargetSourceRegistry();
		const first = fakeSource("discord");
		const second = fakeSource("discord");
		const slack = fakeSource("slack");
		reg.register(first);
		reg.register(slack);
		reg.register(second);

		expect(reg.get("discord")).toBe(second);
		expect(await reg.get("discord")?.enumerate({})).toEqual([]);
		expect(reg.list()).toEqual([second, slack]);
	});

	it("list() hands out a fresh array — mutating it leaves the registry intact", () => {
		const reg = createTargetSourceRegistry();
		const discord = fakeSource("discord");
		reg.register(discord);

		const snapshot = reg.list();
		snapshot.push(fakeSource("slack"));

		expect(snapshot).toHaveLength(2);
		expect(reg.list()).toEqual([discord]);
		expect(reg.list()).not.toBe(snapshot);
	});
});

describe("TargetSourceRegistryService (via ./index)", () => {
	it("carries the barrel's service-type constant", () => {
		expect(TargetSourceRegistryService.serviceType).toBe(
			CONNECTOR_TARGET_SOURCE_REGISTRY_SERVICE,
		);
	});

	it("delegates register / get / list / unregister to its registry", async () => {
		const svc = await TargetSourceRegistryService.start({} as never);
		expect(svc.list()).toEqual([]);

		const discord = fakeSource("discord");
		svc.register(discord);
		const slack = fakeSource("slack");
		svc.register(slack);

		expect(svc.get("discord")).toBe(discord);
		expect(svc.get("missing")).toBeUndefined();
		expect(svc.list()).toEqual([discord, slack]);

		svc.unregister("slack");
		expect(svc.list()).toEqual([discord]);
	});

	it("stop() clears every source and the service accepts registrations again", async () => {
		const svc = await TargetSourceRegistryService.start({} as never);
		const discord = fakeSource("discord");
		svc.register(discord);

		await svc.stop();
		expect(svc.list()).toEqual([]);
		expect(svc.get("discord")).toBeUndefined();

		const again = fakeSource("discord");
		svc.register(again);
		expect(svc.get("discord")).toBe(again);
	});

	it("stop() on a service with no sources does not throw", async () => {
		const svc = await TargetSourceRegistryService.start({} as never);
		await expect(svc.stop()).resolves.toBeUndefined();
	});
});
