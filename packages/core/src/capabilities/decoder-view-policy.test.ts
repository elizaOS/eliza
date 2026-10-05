import { describe, expect, it } from "vitest";
import type { JsonObject } from "../types/primitives";
import { requireRemotePluginModuleArray } from "./decoder";

function decode(viewKind: string) {
	const policy: JsonObject = { viewKind };
	return requireRemotePluginModuleArray(
		{
			modules: [
				{
					id: "view-policy",
					name: "View policy",
					app: {
						...policy,
						navTabs: [
							{ ...policy, id: "panel", label: "Panel", path: "/panel" },
						],
					},
					widgets: [
						{ ...policy, id: "widget", label: "Widget", slot: "chat-sidebar" },
					],
					views: [
						{
							...policy,
							id: "view",
							label: "View",
							viewType: "xr",
							surface: { header: "immersive" },
						},
					],
				},
			],
		},
		"modules",
		"plugin.list",
	)[0];
}

describe("remote view policy", () => {
	it("preserves explicit visibility across apps, tabs, widgets and XR views", () => {
		const module = decode("developer");
		expect(module.app?.viewKind).toBe("developer");
		expect(module.app?.navTabs?.[0]?.viewKind).toBe("developer");
		expect(module.widgets?.[0]?.viewKind).toBe("developer");
		expect(module.views?.[0]).toMatchObject({
			viewKind: "developer",
			viewType: "xr",
			surface: { header: "immersive" },
		});
	});

	it("rejects an unknown visibility category at the transport boundary", () => {
		expect(() => decode("hidden-ish")).toThrow("viewKind must be");
	});
});
