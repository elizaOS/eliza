/**
 * Current-view provider tests for exposing active renderer state to agent context.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	getCurrentView: vi.fn(),
	listViews: vi.fn(),
	createViewsClient: vi.fn(),
}));

vi.mock("../actions/views-client.js", () => ({
	createViewsClient: (options?: { clientId?: string }) => {
		h.createViewsClient(options);
		return {
			getCurrentView: () => h.getCurrentView(options?.clientId),
			listViews: () => h.listViews(options?.clientId),
		};
	},
	readViewClientId: (message: Memory) =>
		typeof message.metadata?.clientId === "string"
			? message.metadata.clientId
			: undefined,
}));

import { currentViewProvider } from "./current-view.js";

const reportError = vi.fn();
const runtime = { reportError } as unknown as IAgentRuntime;
const SIMPLE_VIEWS = [
	{
		id: "simple-calendar",
		label: "Simple Calendar",
		path: "/simple-calendar",
		pluginName: "@elizaos/plugin-simple-views",
		available: true,
	},
	{
		id: "notes",
		label: "Notes",
		path: "/notes",
		pluginName: "@elizaos/plugin-simple-views",
		available: true,
	},
	{
		id: "documents",
		label: "Documents",
		description: "Knowledge documents and notes",
		path: "/documents",
		pluginName: "core",
		available: true,
	},
];

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
		h.listViews.mockReset();
		h.listViews.mockResolvedValue([]);
		h.createViewsClient.mockReset();
		reportError.mockReset();
	});

	it("declares its planner routing context explicitly", () => {
		expect(currentViewProvider.contexts).toEqual(["general"]);
	});

	it("reads current-view state from the renderer that originated the turn", async () => {
		h.getCurrentView.mockResolvedValue(null);
		const message = msg("where am I?");
		message.metadata = {
			type: "message",
			clientId: "shell-a",
		};
		await currentViewProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});
		expect(h.createViewsClient).toHaveBeenCalledWith({ clientId: "shell-a" });
	});

	it("keeps current-view context independent for two clients in one room", async () => {
		h.getCurrentView.mockImplementation(async (clientId?: string) => ({
			viewId: clientId === "shell-a" ? "calendar" : "notes",
			viewLabel: clientId === "shell-a" ? "Calendar" : "Notes",
			viewPath: clientId === "shell-a" ? "/calendar" : "/notes",
			viewType: "gui",
			updatedAt: "2026-07-17T12:00:00.000Z",
		}));
		const shellA = msg("what is open?");
		shellA.id = "00000000-0000-0000-0000-00000000000a";
		shellA.metadata = { type: "message", clientId: "shell-a" };
		const shellB = msg("what is open?");
		shellB.id = "00000000-0000-0000-0000-00000000000b";
		shellB.metadata = { type: "message", clientId: "shell-b" };

		const [contextA, contextB] = await Promise.all([
			currentViewProvider.get(runtime, shellA, {
				values: {},
				data: {},
				text: "",
			}),
			currentViewProvider.get(runtime, shellB, {
				values: {},
				data: {},
				text: "",
			}),
		]);

		expect(shellA.roomId).toBe(shellB.roomId);
		expect(contextA.values?.currentViewId).toBe("calendar");
		expect(contextB.values?.currentViewId).toBe("notes");
		expect(h.getCurrentView).toHaveBeenCalledWith("shell-a");
		expect(h.getCurrentView).toHaveBeenCalledWith("shell-b");
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

	it.each(["open calendar", "can u open calender", "open simple-calendar"])(
		"canonicalizes the requested calendar target before comparing current state: %s",
		async (request) => {
			h.listViews.mockResolvedValue(SIMPLE_VIEWS);
			h.getCurrentView.mockResolvedValue({
				viewId: "simple-calendar",
				viewLabel: "Simple Calendar",
				viewPath: "/simple-calendar",
				viewType: "gui",
				updatedAt: "x",
			});

			const r = await currentViewProvider.get(runtime, msg(request), {
				values: {},
				data: {},
				text: "",
			});

			expect(r.text).toContain("currently viewing the Simple Calendar view");
			expect(r.text).not.toContain("navigation completes");
			expect(r.values?.currentViewId).toBe("simple-calendar");
			expect(r.values?.viewSwitchPending).toBeUndefined();
		},
	);

	it("reports the registered canonical id while a calendar alias is still pending", async () => {
		h.listViews.mockResolvedValue(SIMPLE_VIEWS);
		h.getCurrentView.mockResolvedValue({
			viewId: "notes",
			viewLabel: "Notes",
			viewPath: "/notes",
			viewType: "gui",
			updatedAt: "x",
		});

		const r = await currentViewProvider.get(
			runtime,
			msg("could you open calender"),
			{ values: {}, data: {}, text: "" },
		);

		expect(r.text).toContain("Requested view target: Simple Calendar");
		expect(r.values?.switchingToViewId).toBe("simple-calendar");
		expect(r.values?.viewSwitchPending).toBe(true);
	});

	it("keeps standalone Notes canonical and distinct from Documents", async () => {
		h.listViews.mockResolvedValue(SIMPLE_VIEWS);
		h.getCurrentView.mockResolvedValue({
			viewId: "documents",
			viewLabel: "Documents",
			viewPath: "/documents",
			viewType: "gui",
			updatedAt: "x",
		});

		const r = await currentViewProvider.get(runtime, msg("open notes"), {
			values: {},
			data: {},
			text: "",
		});

		expect(r.text).toContain("Requested view target: Notes");
		expect(r.values?.switchingToViewId).toBe("notes");
		expect(r.values?.viewSwitchPending).toBe(true);
	});

	it("does not canonicalize standalone Notes to Documents when Notes is unavailable", async () => {
		h.listViews.mockResolvedValue(
			SIMPLE_VIEWS.filter((view) => view.id !== "notes"),
		);
		h.getCurrentView.mockResolvedValue({
			viewId: "documents",
			viewLabel: "Documents",
			viewPath: "/documents",
			viewType: "gui",
			updatedAt: "x",
		});

		const r = await currentViewProvider.get(runtime, msg("open notes"), {
			values: {},
			data: {},
			text: "",
		});

		expect(r.text).toContain("Requested view target: Notes");
		expect(r.text).not.toContain("Requested view target: Documents");
		expect(r.values?.switchingToViewId).toBe("notes");
	});

	it("recognizes a completed Notes navigation without leaving a pending target", async () => {
		h.listViews.mockResolvedValue(SIMPLE_VIEWS);
		h.getCurrentView.mockResolvedValue({
			viewId: "notes",
			viewLabel: "Notes",
			viewPath: "/notes",
			viewType: "gui",
			updatedAt: "x",
		});

		const r = await currentViewProvider.get(runtime, msg("switch to notes"), {
			values: {},
			data: {},
			text: "",
		});

		expect(r.text).toContain("currently viewing the Notes view");
		expect(r.values?.viewSwitchPending).toBeUndefined();
	});

	it("uses the user request rather than a surface named in retrieved context", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "chat",
			viewLabel: "Messages",
			viewPath: "/chat",
			viewType: "gui",
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(
			runtime,
			msg(augmented("Open Notes")),
			{ values: {}, data: {}, text: "" },
		);
		expect(r.text).toContain("Notes");
		expect(r.text).not.toContain("Inbox");
		expect(r.values?.switchingToViewId).toBe("notes");
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

	it("keeps current and raw target context when only the view catalog is unavailable", async () => {
		const error = new Error("catalog unavailable");
		h.listViews.mockRejectedValue(error);
		h.getCurrentView.mockResolvedValue({
			viewId: "settings",
			viewLabel: "Settings",
			viewPath: "/settings",
			viewType: "gui",
			updatedAt: "x",
		});
		const message = msg("open wallet");

		const r = await currentViewProvider.get(runtime, message, {
			values: {},
			data: {},
			text: "",
		});

		expect(r.text).toContain("Requested view target: Wallet");
		expect(r.text).toContain("still on Settings");
		expect(r.values?.switchingToViewId).toBe("wallet");
		expect(reportError).toHaveBeenCalledWith(
			"app-control.view-catalog",
			error,
			{ messageId: message.id, roomId: message.roomId },
		);
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

	it("reports every visible split pane while keeping the primary view explicit", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "notes",
			viewLabel: "Notes",
			viewPath: "/notes",
			viewType: "gui",
			views: ["notes", "simple-calendar"],
			layout: "horizontal",
			justSwitched: false,
			updatedAt: "x",
		});
		const r = await currentViewProvider.get(runtime, msg("add one here"), {
			values: {},
			data: {},
			text: "",
		});
		expect(r.text).toContain("Visible panes: notes, simple-calendar");
		expect(r.text).toContain("horizontal layout");
		expect(r.text).toContain("notes is primary");
	});

	it("answers focused and visible-view questions from renderer state without inventing a Focus navigation", async () => {
		h.getCurrentView.mockResolvedValue({
			viewId: "notes",
			viewLabel: "Notes",
			viewPath: "/notes",
			viewType: "gui",
			views: ["notes", "simple-calendar"],
			layout: "horizontal",
			justSwitched: false,
			updatedAt: "x",
		});

		const r = await currentViewProvider.get(
			runtime,
			msg(
				"name the focused view and the other visible view, one short sentence",
			),
			{ values: {}, data: {}, text: "" },
		);

		expect(r.text).toContain("currently viewing the Notes view");
		expect(r.text).toContain("Visible panes: notes, simple-calendar");
		expect(r.text).not.toContain("Requested view target: Focus");
		expect(r.values?.viewSwitchPending).toBeUndefined();
	});
});
/**
 * Current-view provider tests for exposing active renderer state to agent context.
 */
