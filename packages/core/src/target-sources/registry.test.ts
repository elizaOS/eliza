import { describe, expect, it } from "vitest";
import {
	createTargetSourceRegistry,
	type TargetGroup,
	type TargetSource,
	TargetSourceRegistryService,
} from "./registry";

function fakeSource(
	platform: string,
	groups: TargetGroup[] = [],
): TargetSource {
	return {
		platform,
		async enumerate() {
			return groups;
		},
	};
}

describe("createTargetSourceRegistry", () => {
	it("registers, gets, lists, and unregisters by platform", () => {
		const reg = createTargetSourceRegistry();
		expect(reg.list()).toEqual([]);

		const discord = fakeSource("discord");
		reg.register(discord);
		expect(reg.get("discord")).toBe(discord);
		expect(reg.list()).toEqual([discord]);

		reg.unregister("discord");
		expect(reg.get("discord")).toBeUndefined();
		expect(reg.list()).toEqual([]);
	});

	it("keys by platform — re-registering replaces the prior source", () => {
		const reg = createTargetSourceRegistry();
		const a = fakeSource("discord");
		const b = fakeSource("discord");
		reg.register(a);
		reg.register(b);
		expect(reg.list()).toEqual([b]);
		expect(reg.get("discord")).toBe(b);
	});
});

describe("TargetSourceRegistryService", () => {
	it("exposes the connector-target-source registry service type", () => {
		expect(TargetSourceRegistryService.serviceType).toBe(
			"ConnectorTargetSourceRegistry",
		);
	});

	it("wraps a registry and clears sources on stop", async () => {
		const svc = await TargetSourceRegistryService.start({} as never);
		const source = fakeSource("discord");
		svc.register(source);
		expect(svc.list()).toEqual([source]);
		expect(svc.get("discord")).toBe(source);

		await svc.stop();
		expect(svc.list()).toEqual([]);
	});
});
