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

const reportError = vi.fn();
const runtime = { reportError } as unknown as IAgentRuntime;
function msg(text: string): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000000",
		entityId: "22222222-2222-2222-2222-222222222222",
		roomId: "11111111-1111-1111-1111-111111111111",
		content: { text },
	} as Memory;
}

function augmented(userRequest: string): string {
	return [
		"Answer the user request using the contextual documents below as the source of truth when they contain the answer.",
		"<contextual_documents>",
		'<source title="source-1">Open the inbox to review messages.</source>',
		"</contextual_documents>",
		"<user_request>",
		userRequest,
		"</user_request>",
	].join("\n");
}

describe("current_view state provider", () => {
	beforeEach(() => {
		h.getCurrentView.mockReset();
		reportError.mockReset();
	});

	it("declares its planner routing context explicitly", () => {
		expect(currentViewProvider.contexts).toEqual(["general"]);
	});

	it("makes an imminent explicit target authoritative over the current renderer", async () => {
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
		expect(r.text).toContain("Requested view target: Wallet");
		expect(r.text).toContain("still on Settings");
		expect(r.text).toContain("authoritative for this turn");
		expect(r.text).not.toContain("acknowledge");
		expect(r.text).toContain("Wallet");
		expect(r.values?.switchingToViewId).toBe("wallet");
		expect(r.values?.viewSwitchPending).toBe(true);
	});

	it("uses the user request rather than a surface named in retrieved context", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "chat",
			viewLabel: "Messages",
			viewPath: "/chat",
			viewType: "gui",
			updatedAt: "x",
		});
		const result = await currentViewProvider.get(
			runtime,
			msg(augmented("Open Notes")),
			{ values: {}, data: {}, text: "" },
		);
		expect(result.text).toContain("Notes");
		expect(result.text).not.toContain("Inbox");
		expect(result.values?.switchingToViewId).toBe("notes");
	});

	it("reports a recent agent switch as state without requesting another acknowledgement", async () => {
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
		expect(r.text).toContain("currently viewing the Calendar view");
		expect(r.text).not.toContain("acknowledge");
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
		expect(r.text).toContain("currently viewing the Calendar view (/calendar)");
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

	it("reports an imminent target even with no prior current view", async () => {
		h.getCurrentView.mockResolvedValue(null);
		const r = await currentViewProvider.get(runtime, msg("open my wallet"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("Wallet");
		expect(r.values?.switchingToViewId).toBe("wallet");
	});

	it("reports an unavailable current-view boundary without breaking composition", async () => {
		const error = new Error("loopback unavailable");
		h.getCurrentView.mockRejectedValue(error);
		const message = msg("how are you");
		const r = await currentViewProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toBe("");
		expect(reportError).toHaveBeenCalledWith(
			"app-control.current-view",
			error,
			{ messageId: message.id, roomId: message.roomId },
		);
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
