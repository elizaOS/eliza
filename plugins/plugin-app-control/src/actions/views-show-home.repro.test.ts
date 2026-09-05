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
		...actual,
		...coreMock,
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

	it("resolves the canonical Home alias before a fuzzy Home Budget match", async () => {
		const homeBudget = {
			...chatView(),
			id: "home-budget",
			label: "Home Budget",
			path: "/home-budget",
		};
		const { result, fetchMock, callback } = await runCase(
			"Read my note, then go home.",
			{ action: "show", view: "Home" },
			[homeBudget, ...fullRegistry()],
		);
		expect(result).toMatchObject({
			success: true,
			transcriptVisibility: "internal",
			values: { viewId: "chat", viewPath: "/" },
		});
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
			"/api/views/chat/navigate",
		);
		expect(callback).not.toHaveBeenCalled();
	});

	it.each(["id", "label"])(
		"preserves an exact registered %s before the canonical Home alias",
		async (field) => {
			const exactHome = {
				...chatView(),
				id: "custom-home",
				label: "Custom Home",
				path: "/custom-home",
				[field]: "Home",
			};
			const { result, fetchMock } = await runCase(
				"Open the supplied destination.",
				{ action: "show", view: "Home" },
				[exactHome, ...fullRegistry()],
			);
			expect(result).toMatchObject({
				success: true,
				values: { viewId: exactHome.id, viewPath: "/custom-home" },
			});
			expect(fetchMock).toHaveBeenCalledTimes(1);
			expect(String(fetchMock.mock.calls[0]?.[0])).toContain(
				`/api/views/${exactHome.id}/navigate`,
			);
		},
	);

	it("does not replace an unavailable canonical Home with fuzzy Home Budget", async () => {
		const { result, fetchMock, callback } = await runCase(
			"Go home.",
			{ action: "show", view: "Home" },
			[
				{
					...chatView(),
					id: "home-budget",
					label: "Home Budget",
					path: "/home-budget",
				},
				...noHomeRegistry(),
			],
		);
		expect(result).toMatchObject({
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});

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

	describe.each([false, true])(
		"compound request with nested options=%s",
		(nested) => {
			it.each(["view", "viewId", "id", "target", "name"])(
				"honors the explicit %s destination after a note read",
				async (targetKey) => {
					const parameters = { action: "show", [targetKey]: "chat" };
					const { result, fetchMock, callback } = await runCase(
						"Read my Continuity check 2145 note, then go home and tell me its text. Do not change the note.",
						nested ? { parameters } : parameters,
						fullRegistry(),
					);

					expect(result).toMatchObject({
						success: true,
						transcriptVisibility: "internal",
						modelReplyRequired: true,
						values: { mode: "show", viewId: "chat", viewPath: "/" },
					});
					expect(JSON.parse(result.text ?? "{}")).toMatchObject({
						effect: "view_navigation",
						status: "accepted",
						viewId: "chat",
						path: "/",
					});
					expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
						"http://127.0.0.1:3456/api/views/chat/navigate",
						expect.objectContaining({ method: "POST" }),
					);
					expect(callback).not.toHaveBeenCalled();
					expect(result).not.toHaveProperty("verifiedUserFacing");
				},
			);
		},
	);

	it("does not replace an unavailable explicit destination with the note-read surface", async () => {
		const { result, fetchMock, callback } = await runCase(
			"Read my note, then go to the requested view.",
			{ action: "show", view: "missing-destination" },
			fullRegistry(),
		);
		expect(result).toMatchObject({
			success: false,
			transcriptVisibility: "internal",
			turnComplete: false,
		});
		expect(fetchMock).not.toHaveBeenCalled();
		expect(callback).not.toHaveBeenCalled();
	});

	it.each(["go home", "Read my note.", "open my calendar", "打开笔记"])(
		"requires a structured destination instead of inferring one from %s",
		async (text) => {
			const { result, fetchMock, callback } = await runCase(
				text,
				{ parameters: { action: "show" } },
				fullRegistry(),
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				turnComplete: false,
			});
			expect(fetchMock).not.toHaveBeenCalled();
			expect(callback).not.toHaveBeenCalled();
		},
	);

	it("does not replace explicit Documents with a note mentioned elsewhere in the request", async () => {
		const { result, fetchMock } = await runCase(
			"Read my note, then open the requested destination.",
			{ action: "show", view: "documents" },
			[
				...fullRegistry(),
				{
					...notesView(),
					id: "documents",
					label: "Documents",
					path: "/documents",
				},
			],
		);
		expect(result.values).toMatchObject({ viewId: "documents" });
		expect(fetchMock).toHaveBeenCalledExactlyOnceWith(
			"http://127.0.0.1:3456/api/views/documents/navigate",
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
