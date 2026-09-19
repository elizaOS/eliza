/** Proves structured renderer metadata gives Stage 1 enough context for model-owned view follow-ups. */

import { describe, expect, it } from "vitest";
import type { IAgentRuntime, Memory, State } from "../../../types/index.ts";
import { uiContextProvider } from "./uiContext.ts";

describe("UI_CONTEXT", () => {
	it("renders focused-view identity, path, and capability hints", async () => {
		const result = await uiContextProvider.get(
			{} as IAgentRuntime,
			{
				content: {
					metadata: {
						uiView: "notes",
						uiTab: "views",
						uiViewSubview: "general",
						uiViewPath: "/notes",
						uiViewCapabilities: ["view-actions", "inspect-view"],
						uiViewActionNames: ["NOTES"],
						__responseContext: {
							primaryContext: "apps",
							secondaryContexts: ["general"],
						},
					},
				},
			} as Memory,
			{ values: {}, data: {}, text: "" } as State,
		);

		expect(result.text).toContain("view: notes");
		expect(result.text).toContain("path: /notes");
		expect(result.text).toContain("subview_id: general");
		expect(result.text).toContain(
			"view_capabilities: view-actions, inspect-view",
		);
		expect(result.text).toContain("view_actions: NOTES");
		expect(result.text).toContain(
			"view_capabilities is context, not an invocation request",
		);
		expect(result.text).toContain(
			"not displayed content or current record values",
		);
		expect(result.text).toContain("opening is not a record operation");
		expect(result.data).toEqual({
			uiView: "notes",
			uiTab: "views",
			uiViewSubview: "general",
			uiViewPath: "/notes",
			uiViewCapabilities: ["view-actions", "inspect-view"],
			uiViewActionNames: ["NOTES"],
			activeContexts: ["apps", "general"],
		});
		expect(result.values).toEqual({
			uiView: "notes",
			uiTab: "views",
			uiViewSubview: "general",
			uiViewPath: "/notes",
			uiViewCapabilities: "view-actions, inspect-view",
			uiViewActionNames: "NOTES",
			uiContexts: "apps, general",
		});
	});

	it("stays silent without renderer or routing context", async () => {
		const result = await uiContextProvider.get(
			{} as IAgentRuntime,
			{ content: {} } as Memory,
			{ values: {}, data: {}, text: "" } as State,
		);
		expect(result.text).toBe("");
	});
});
