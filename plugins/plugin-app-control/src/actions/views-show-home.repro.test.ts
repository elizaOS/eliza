/**
 * Regression for #17299: an explicit VIEWS `show/home` request issued while
 * Notes is the foreground view must execute Home navigation. It must never be
 * rewritten into the foreground view's `get-notes` capability, which printed
 * the user's note contents as a verified, turn-completing tool result.
 */
import { describe, expect, it, vi } from "vitest";
import { createViewsAction } from "./views.js";
import type { ViewSummary, ViewsClient } from "./views-client.js";
import { runViewsShow } from "./views-show.js";

const coreMock = vi.hoisted(() => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
	ModelType: { TEXT_SMALL: "TEXT_SMALL" },
	resolveServerOnlyPort: vi.fn(() => 3456),
	formatError: (error: unknown): string =>
		error instanceof Error ? error.message : String(error),
	spawnWithTrajectoryLink: vi.fn(
		async (
			_runtime: unknown,
			_source: unknown,
			run: (trajectory: {
				parentStepId: string;
				linkChild: (sessionId: string) => Promise<void>;
			}) => Promise<unknown>,
		) => run({ parentStepId: "p1", linkChild: vi.fn(async () => {}) }),
	),
	hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...coreMock,
		ElizaError: actual.ElizaError,
		findCodingDelegationActionName: actual.findCodingDelegationActionName,
		getUserMessageText: actual.getUserMessageText,
		resolveStateDir: actual.resolveStateDir,
		unwrapUserMessageText: actual.unwrapUserMessageText,
	};
});

function message(text: string, roomId = "room-1") {
	return { entityId: "user-1", roomId, agentId: "agent-1", content: { text } };
}

function createRuntime() {
	return {
		runtime: {
			agentId: "agent-1",
			getSetting: vi.fn(() => undefined),
			getTasks: vi.fn(async () => []),
			createTask: vi.fn(async () => {}),
			deleteTask: vi.fn(async () => {}),
			useModel: vi.fn(async () => ""),
		},
	};
}

// Production-shape registry: the real plugin-notes Notes and plugin-calendar
// Calendar catalog entries (labels, tags, capability ids/descriptions) plus
// the builtin chat/home surface.
const notesView = (): ViewSummary =>
	({
		id: "notes",
		label: "Notes",
		viewType: "gui",
		path: "/notes",
		description:
			"Durable notes that the user and agent can create, read, update, and delete.",
		tags: ["notes", "notepad", "sticky notes", "scratchpad", "view switching"],
		capabilities: [
			{
				id: "get-notes",
				description: "List every sticky note as structured data.",
			},
			{ id: "get-note", description: "Read one sticky note by id." },
			{ id: "create-note", description: "Create a durable sticky note." },
			{
				id: "update-note",
				description: "Update one or more fields on a sticky note.",
			},
			{
				id: "delete-note",
				description:
					"Delete one sticky note by id, exact title, or unique query.",
			},
		],
	}) as unknown as ViewSummary;

const calendarView = (): ViewSummary =>
	({
		id: "calendar",
		label: "Calendar",
		viewType: "gui",
		path: "/calendar",
		description:
			"Unified Google, Microsoft, Apple, and ICS calendar with day/week/month tabs and inline conflict detection.",
		tags: ["calendar", "schedule", "events"],
		capabilities: [],
	}) as unknown as ViewSummary;

const chatView = (): ViewSummary =>
	({
		id: "chat",
		label: "Chat",
		viewType: "gui",
		path: "/",
		// Deliberately no "home" token anywhere: in the live repro the registry
		// could not resolve "home" by id/label/tag/description, which is what
		// forced the foreground-view fallback.
		description: "Main chat.",
		tags: ["chat"],
		capabilities: [],
	}) as unknown as ViewSummary;

function makeAction(views: ViewSummary[]) {
	const fetchMock = vi.fn(
		async () =>
			({
				ok: true,
				status: 200,
				text: async () => "",
				json: async () => ({
					success: true,
					result: {
						text: "Check Twitter: Check Twitter 1x a day.",
						success: true,
					},
				}),
			}) as unknown as Response,
	);
	vi.stubGlobal("fetch", fetchMock);
	const action = createViewsAction({
		client: {
			listViews: vi.fn(async () => views),
			getCurrentView: vi.fn(async () => ({
				viewId: "notes",
				viewLabel: "Notes",
				viewType: "gui" as const,
				viewPath: "/notes",
			})),
		},
		hasOwnerAccess: vi.fn(async () => true),
	});
	return { action, fetchMock };
}

// The composed retrieval prompt shape some runtimes hand the action instead of
// the raw user message. The contextual documents carry note-flavored text, so
// token-overlap capability scoring is maximally tempted toward Notes.
function composedPrompt(userRequest: string): string {
	return [
		"Answer the user request using the contextual documents below as the source of truth.",
		"",
		"<contextual_documents>",
		'<source title="sticky notes" similarity="1.000">',
		"Check Twitter: Check Twitter 1x a day. Sticky note wall notes list.",
		"</source>",
		"</contextual_documents>",
		"",
		"<user_request>",
		userRequest,
		"</user_request>",
	].join("\n");
}

async function runCase(
	text: string,
	options: Record<string, unknown>,
	views: ViewSummary[],
) {
	const { runtime } = createRuntime();
	const callback = vi.fn();
	const { action, fetchMock } = makeAction(views);
	const result = (await action.handler(
		runtime as never,
		message(text) as never,
		undefined,
		options,
		callback,
	)) as {
		success?: boolean;
		values?: Record<string, unknown>;
		text?: string;
		transcriptVisibility?: string;
		userFacingText?: string;
		verifiedUserFacing?: boolean;
		turnComplete?: boolean;
	};
	return { result, fetchMock, callback };
}

describe("VIEWS show/home with Notes foreground (#17299)", () => {
	const fullRegistry = () => [chatView(), notesView(), calendarView()];
	const noHomeRegistry = () => [notesView(), calendarView()];

	const cases: Array<{
		name: string;
		text: string;
		options: Record<string, unknown>;
		views: () => ViewSummary[];
	}> = [
		// Bidirectional-proof cases: these misrouted to notes:get-notes on
		// develop before the fix (effectiveMode=interact,
		// resolvedCapability=notes:get-notes).
		{
			name: "'show home' with explicit show/home target",
			text: "show home",
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
		{
			name: "'show home' with explicit target and no registered home view",
			text: "show home",
			options: { action: "show", view: "home" },
			views: noHomeRegistry,
		},
		{
			name: "composed retrieval prompt around 'go home'",
			text: composedPrompt("go home"),
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
		// Guardrail cases: correct before and after; pinned so the routing seam
		// cannot regress in the other direction.
		{
			name: "'go home' with explicit show/home target",
			text: "go home",
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
		{
			name: "'go home' with inferred target",
			text: "go home",
			options: { action: "show" },
			views: fullRegistry,
		},
		{
			name: "typo 'go homw' normalized by the planner to show/home",
			text: "go homw",
			options: { action: "show", view: "home" },
			views: fullRegistry,
		},
	];

	for (const testCase of cases) {
		it(`${testCase.name} never invokes a Notes capability`, async () => {
			const { result, fetchMock } = await runCase(
				testCase.text,
				testCase.options,
				testCase.views(),
			);
			const interactCalls = fetchMock.mock.calls.filter(([url]) =>
				String(url).includes("/interact"),
			);
			expect(interactCalls).toEqual([]);
			expect(result?.values?.mode).not.toBe("interact");
			expect(String(result?.text ?? "")).not.toContain("Check Twitter");
		});
	}

	it("navigates to the registered chat view for show/home", async () => {
		const { result, fetchMock } = await runCase(
			"show home",
			{ action: "show", view: "home" },
			fullRegistry(),
		);
		expect(result?.values).toMatchObject({ mode: "show", viewId: "chat" });
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("canonicalizes a planner-supplied home alias for bare go back", async () => {
		const { result, fetchMock, callback } = await runCase(
			"go back",
			{ action: "show", view: "home" },
			fullRegistry(),
		);
		expect(result?.values).toMatchObject({ mode: "show", viewId: "chat" });
		expect(callback).not.toHaveBeenCalled();
		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			modelReplyRequired: true,
		});
		expect(result).not.toHaveProperty("turnComplete");
		expect(result).not.toHaveProperty("userFacingText");
		expect(result).not.toHaveProperty("verifiedUserFacing");
		expect(JSON.parse(result?.text ?? "{}")).toMatchObject({
			effect: "view_navigation",
			status: "accepted",
			viewId: "chat",
			label: "Home",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("reports one grounded failure when the shell rejects Home navigation", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("shell unavailable", { status: 503 })),
		);
		const callback = vi.fn();
		const result = await runViewsShow({
			client: {
				listViews: vi.fn(async () => fullRegistry()),
			} as unknown as ViewsClient,
			message: message("go back") as never,
			options: { action: "show", view: "home" },
			callback,
		});

		expect(result.success).toBe(false);
		expect(JSON.parse(result.text ?? "{}")).toMatchObject({
			effect: "view_navigation",
			status: "unconfirmed",
			viewId: "chat",
			label: "Home",
		});
		expect(result).not.toHaveProperty("verifiedUserFacing");
		expect(result.turnComplete).toBe(false);
		expect(callback).not.toHaveBeenCalled();
	});

	it("still reaches Notes through an explicit interact capability request", async () => {
		const { result } = await runCase(
			"show me my notes",
			{ action: "interact", view: "notes", capability: "get-notes" },
			fullRegistry(),
		);
		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "get-notes",
		});
	});
});
