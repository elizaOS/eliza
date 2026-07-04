/**
 * Current-view provider tests for exposing active renderer state to agent context.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ getCurrentView: vi.fn() }));

vi.mock("../actions/views-client.js", () => ({
	createViewsClient: () => ({ getCurrentView: h.getCurrentView }),
}));

import { currentViewProvider } from "./current-view.js";

const runtime = {} as IAgentRuntime;
function msg(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		entityId: "22222222-2222-2222-2222-222222222222",
		roomId: "11111111-1111-1111-1111-111111111111",
		content: { text },
	} as Memory;
}

describe("current_view acknowledgement provider (#8788)", () => {
	beforeEach(() => h.getCurrentView.mockReset());

	it("phrases an imminent explicit switch as a forward-looking acknowledgement", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "settings",
			viewLabel: "Settings",
			viewPath: "/settings",
			viewType: "gui",
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(runtime, msg("open my wallet"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("switching them there now");
		expect(r.text).toContain("Wallet");
		expect(r.values?.switchingToViewId).toBe("wallet");
		expect(r.values?.viewJustSwitched).toBe(true);
	});

	it("acknowledges a switch the agent just executed (server justSwitched, source agent)", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "calendar",
			viewLabel: "Calendar",
			viewPath: "/calendar",
			viewType: "gui",
			justSwitched: true,
			source: "agent",
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(runtime, msg("thanks!"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("You just switched the user to the Calendar view");
	});

	it("does not claim credit when the user switched themselves (source user)", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "calendar",
			viewLabel: "Calendar",
			viewPath: "/calendar",
			viewType: "gui",
			justSwitched: true,
			source: "user",
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(runtime, msg("ok"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain(
			"switched to the Calendar view (/calendar) themselves",
		);
		expect(r.text).not.toContain("You just switched");
	});

	it("falls back to ambient phrasing when nothing switched", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "calendar",
			viewLabel: "Calendar",
			viewPath: "/calendar",
			viewType: "gui",
			justSwitched: false,
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(runtime, msg("ok"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("currently viewing");
	});

	it("returns empty when no current view and no imminent switch", async () => {
		h.getCurrentView.mockResolvedValue(null);
		const r = await currentViewProvider.get(runtime, msg("how are you"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toBe("");
	});

	it("still acknowledges an imminent switch even with no prior current view", async () => {
		h.getCurrentView.mockResolvedValue(null);
		const r = await currentViewProvider.get(runtime, msg("open my wallet"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("Wallet");
		expect(r.values?.switchingToViewId).toBe("wallet");
	});

	it("surfaces the open subview/section for a view that has one (#9945)", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "settings",
			viewLabel: "Settings",
			viewPath: "/settings",
			viewType: "gui",
			subview: "voice",
			justSwitched: false,
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(runtime, msg("ok"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("currently viewing");
		expect(r.text).toContain("voice section");
		expect(r.values?.currentViewSubview).toBe("voice");
	});
});
/**
 * Current-view provider tests for exposing active renderer state to agent context.
 */
