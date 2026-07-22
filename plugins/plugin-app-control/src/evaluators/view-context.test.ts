/**
 * View context evaluator tests for model-guided navigation from situational cues.
 */

import type {
	EvaluatorProcessorContext,
	EvaluatorPromptContext,
	EvaluatorRunContext,
	Memory,
} from "@elizaos/core";
import { VIEW_SCOPE_IDLE_TTL_MS } from "@elizaos/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	BASELINE_VIEW_CONTEXT_INSTRUCTION,
	type ViewContextOutput,
	viewContextEvaluator,
} from "./view-context.js";

const REGISTERED_VIEW_IDS = [
	"calendar",
	"inbox",
	"wallet",
	"finances",
	"todos",
	"goals",
	"health",
	"documents",
	"relationships",
	"focus",
	"task-coordinator",
];

function viewSummary(id: string) {
	return {
		id,
		label: id,
		description: `${id} view`,
		path: `/${id}`,
		pluginName: `@local/plugin-${id}`,
		available: true,
		viewType: "gui",
		tags: [id],
	};
}

let nextTurn = 1_000_000;

function turnMessage(text: string, roomId = "r1", clientId?: string): Memory {
	const createdAt = ++nextTurn;
	return {
		id: `m-${createdAt}`,
		entityId: "test-entity",
		roomId,
		createdAt,
		content: { text },
		...(clientId ? { metadata: { type: "message", clientId } } : {}),
	};
}

/** Mock the loopback: list views, current view, capture navigate POSTs. */
function mockLoopback(opts: {
	ids?: readonly string[];
	views?: readonly ReturnType<typeof viewSummary>[];
	current?: string | null;
}) {
	const navigated: string[] = [];
	const views =
		opts.views ?? (opts.ids ?? REGISTERED_VIEW_IDS).map(viewSummary);
	let current = opts.current ?? null;
	let revision = 1;
	vi.mocked(globalThis.fetch).mockImplementation(
		async (url: unknown, init?: RequestInit) => {
			const u = String(url);
			const nav = /\/api\/views\/([^/?]+)\/navigate/.exec(u);
			if (nav) {
				const body = JSON.parse(String(init?.body)) as {
					expectedRevision?: number;
				};
				if (body.expectedRevision !== revision) {
					return { ok: false, status: 409 } as Response;
				}
				current = decodeURIComponent(nav[1]);
				navigated.push(current);
				revision += 1;
				return {
					ok: true,
					status: 200,
					json: async () => ({ ok: true, revision }),
				} as Response;
			}
			if (u.endsWith("/api/views/current")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						currentView: current
							? {
									viewId: current,
									viewPath: `/${current}`,
									viewLabel: current,
									viewType: "gui",
									updatedAt: "2026-06-18T00:00:00.000Z",
								}
							: null,
						revision,
					}),
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ views }),
			} as Response;
		},
	);
	return { navigated };
}

function ctx(
	text: string,
	overrides: Partial<EvaluatorRunContext> = {},
): EvaluatorRunContext {
	return {
		runtime: { actions: [{ name: "VIEWS" }], reportError },
		message: turnMessage(text),
		options: { didRespond: true },
		...overrides,
	} as unknown as EvaluatorRunContext;
}

const reportError = vi.fn();

function processorContext(
	output: ViewContextOutput,
	message: Memory,
): EvaluatorProcessorContext<ViewContextOutput> {
	return {
		output,
		message,
		runtime: ctx("processor fixture").runtime,
		state: { values: {}, data: {}, text: "" },
		options: { didRespond: true },
		prepared: undefined,
		evaluatorName: viewContextEvaluator.name,
	};
}

async function runProcessor(
	output: ViewContextOutput,
	text = "fix the login bug",
) {
	const processor = viewContextEvaluator.processors?.[0];
	if (!processor) throw new Error("no processor");
	return processor.process(processorContext(output, turnMessage(text)));
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

describe("viewContextEvaluator.shouldRun — contextual gate", () => {
	const CONTEXTUAL = [
		"can you fix the login bug",
		"I've got back-to-back meetings tomorrow",
		"help me cut my monthly spending",
		"let's build a new feature for the app",
		"I keep getting distracted while working",
	];
	for (const text of CONTEXTUAL) {
		it(`runs for contextual activity: "${text}"`, async () => {
			expect(await viewContextEvaluator.shouldRun(ctx(text))).toBe(true);
		});
	}

	it("defers to the VIEWS action on a DIRECT nav command (resolveIntentView match)", async () => {
		// "open my calendar" / "muéstrame mi calendario" are direct → the action's job.
		expect(await viewContextEvaluator.shouldRun(ctx("open my calendar"))).toBe(
			false,
		);
		expect(
			await viewContextEvaluator.shouldRun(ctx("muéstrame mi calendario")),
		).toBe(false);
	});

	it("does not reinterpret a multi-view action as one contextual view", async () => {
		for (const text of [
			"split notes and calendar",
			"tile the calendar with my notes",
		]) {
			expect(
				await viewContextEvaluator.shouldRun(
					ctx(text, {
						state: {
							values: {},
							data: {
								actionResults: [
									{
										success: true,
										data: { actionName: "VIEWS" },
									},
								],
							},
							text: "",
						},
					}),
				),
			).toBe(false);
		}
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("split notes and calendar", {
					state: {
						values: {},
						data: {
							actionResults: [
								{
									success: false,
									data: { actionName: "VIEWS" },
								},
							],
						},
						text: "",
					},
				}),
			),
		).toBe(false);
	});

	it("keeps contextual inference after unrelated actions", async () => {
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("can you fix the login bug", {
					state: {
						values: {},
						data: {
							actionResults: [
								{
									success: true,
									data: { actionName: "OTHER_ACTION" },
								},
							],
						},
						text: "",
					},
				}),
			),
		).toBe(true);
	});

	it("does not run on small talk / non-activity", async () => {
		expect(
			await viewContextEvaluator.shouldRun(ctx("thanks, that helped")),
		).toBe(false);
		expect(await viewContextEvaluator.shouldRun(ctx("how are you today"))).toBe(
			false,
		);
	});

	it("does not run on a trivially short message", async () => {
		expect(await viewContextEvaluator.shouldRun(ctx("hi"))).toBe(false);
	});

	it("does not contextually map standalone notes requests to Knowledge", async () => {
		expect(await viewContextEvaluator.shouldRun(ctx("open notes"))).toBe(false);
		expect(await viewContextEvaluator.shouldRun(ctx("show me my notes"))).toBe(
			false,
		);
	});

	it("does not run when VIEWS is not registered", async () => {
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("fix the login bug", { runtime: { actions: [] } } as never),
			),
		).toBe(false);
	});

	it("does not run when the agent did not respond", async () => {
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("fix the login bug", { options: { didRespond: false } }),
			),
		).toBe(false);
	});
});

describe("viewContextEvaluator.prompt — GEPA-optimizable instruction", () => {
	it("falls back to the baseline instruction when no optimized artifact is registered", () => {
		// resolveOptimizedPromptForRuntime returns the baseline when the service is
		// absent (runtime.getService undefined), so the prompt = baseline + the
		// per-turn user message.
		const promptCtx = {
			runtime: { actions: [{ name: "VIEWS" }] },
			message: { content: { text: "fix the login bug" } },
			state: { values: {}, data: {}, text: "" },
			options: { didRespond: true },
			prepared: undefined,
		} as unknown as EvaluatorPromptContext;
		const out = viewContextEvaluator.prompt(promptCtx);
		expect(out).toContain(BASELINE_VIEW_CONTEXT_INSTRUCTION);
		expect(out).toContain("fix the login bug");
	});
});

describe("viewContextEvaluator.parse — output validation", () => {
	it("accepts a registered view id", () => {
		expect(
			viewContextEvaluator.parse?.({ viewId: "task-coordinator" }),
		).toEqual({ viewId: "task-coordinator", reason: undefined });
	});
	it("lower-cases + keeps reason", () => {
		expect(
			viewContextEvaluator.parse?.({ viewId: "Calendar", reason: "meetings" }),
		).toEqual({ viewId: "calendar", reason: "meetings" });
	});
	it('accepts "none"', () => {
		expect(viewContextEvaluator.parse?.({ viewId: "none" })).toEqual({
			viewId: "none",
			reason: undefined,
		});
	});
	it("rejects an unknown view id", () => {
		expect(viewContextEvaluator.parse?.({ viewId: "spaceship" })).toBeNull();
	});
	it("rejects a non-object", () => {
		expect(viewContextEvaluator.parse?.("nope")).toBeNull();
	});
});

describe("viewContextEvaluator processor — navigates on the (mock-LLM) decision", () => {
	beforeEach(() => {
		vi.stubGlobal("fetch", vi.fn());
		reportError.mockReset();
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("navigates to the situation-inferred view (coding → task-coordinator)", async () => {
		const { navigated } = mockLoopback({ current: "chat" });
		const result = await runProcessor({
			viewId: "task-coordinator",
			reason: "coding work",
		});
		expect(navigated).toEqual(["task-coordinator"]);
		expect(result).toMatchObject({
			success: true,
			values: { contextualView: "task-coordinator" },
		});
	});

	it("resolves the calendar domain to the only registered simple-calendar view", async () => {
		const simpleCalendar = {
			...viewSummary("simple-calendar"),
			label: "Calendar",
		};
		const { navigated } = mockLoopback({
			views: [simpleCalendar],
			current: "chat",
		});

		const result = await runProcessor({
			viewId: "calendar",
			reason: "meetings",
		});

		expect(navigated).toEqual(["simple-calendar"]);
		expect(result).toMatchObject({
			success: true,
			values: { contextualView: "simple-calendar" },
		});
	});

	it("prefers the exact calendar id when both calendar variants are registered", async () => {
		const exactCalendar = { ...viewSummary("calendar"), label: "Calendar" };
		const simpleCalendar = {
			...viewSummary("simple-calendar"),
			label: "Calendar",
		};
		const { navigated } = mockLoopback({
			views: [simpleCalendar, exactCalendar],
			current: "chat",
		});

		const result = await runProcessor({
			viewId: "calendar",
			reason: "meetings",
		});

		expect(navigated).toEqual(["calendar"]);
		expect(result).toMatchObject({
			success: true,
			values: { contextualView: "calendar" },
		});
	});

	it("fails closed when the calendar domain has equally ranked candidates", async () => {
		const { navigated } = mockLoopback({
			views: [
				{ ...viewSummary("simple-calendar"), label: "Simple Calendar" },
				{ ...viewSummary("work-calendar"), label: "Work Calendar" },
			],
			current: "chat",
		});

		const result = await runProcessor({
			viewId: "calendar",
			reason: "meetings",
		});

		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it('does NOT navigate when the decision is "none"', async () => {
		const { navigated } = mockLoopback({ current: "chat" });
		const result = await runProcessor({ viewId: "none" });
		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("does NOT navigate to a view that is not registered in this deployment", async () => {
		const { navigated } = mockLoopback({
			ids: REGISTERED_VIEW_IDS.filter((id) => id !== "task-coordinator"),
			current: "chat",
		});
		const result = await runProcessor({ viewId: "task-coordinator" });
		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("navigates to explicitly selected Documents by its registered id", async () => {
		const { navigated } = mockLoopback({ current: "chat" });
		const result = await runProcessor(
			{ viewId: "documents", reason: "documents fit the current activity" },
			"review the documents for this project",
		);
		expect(navigated).toEqual(["documents"]);
		expect(result?.success).toBe(true);
	});

	it("does NOT re-navigate when already on the target view", async () => {
		const { navigated } = mockLoopback({ current: "calendar" });
		const result = await runProcessor({ viewId: "calendar" });
		expect(navigated).toEqual([]);
		expect(result).toBeUndefined();
	});

	it("degrades to no-op when the loopback is unreachable", async () => {
		vi.mocked(globalThis.fetch).mockRejectedValue(new Error("ECONNREFUSED"));
		const result = await runProcessor({ viewId: "task-coordinator" });
		expect(result).toBeUndefined();
		expect(reportError).toHaveBeenCalledWith(
			"app-control.view-context.current-view",
			expect.any(Error),
			{ phase: "before-discovery", viewId: "task-coordinator" },
		);
	});

	it("keeps a newer explicit Notes switch when an older Calendar classifier finishes late", async () => {
		const listStarted = deferred<void>();
		const releaseList = deferred<void>();
		let currentView = "chat";
		let currentRevision = 40;
		let currentReads = 0;
		const navigated: string[] = [];

		vi.mocked(globalThis.fetch).mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/api/views/current")) {
				currentReads += 1;
				return {
					ok: true,
					status: 200,
					json: async () => ({
						currentView: {
							viewId: currentView,
							viewPath: `/${currentView}`,
							viewLabel: currentView,
							viewType: "gui",
							updatedAt: "2026-07-17T12:00:00.000Z",
						},
						revision: currentRevision,
					}),
				} as Response;
			}
			if (u.endsWith("/api/views")) {
				listStarted.resolve();
				await releaseList.promise;
				return {
					ok: true,
					status: 200,
					json: async () => ({ views: REGISTERED_VIEW_IDS.map(viewSummary) }),
				} as Response;
			}
			const nav = /\/api\/views\/([^/?]+)\/navigate/.exec(u);
			if (nav) {
				const target = decodeURIComponent(nav[1]);
				navigated.push(target);
				currentView = target;
				return { ok: true, status: 200 } as Response;
			}
			throw new Error(`unexpected request: ${u}`);
		});

		const olderCreatedAt = ++nextTurn;
		const olderMessage = {
			id: "m-calendar-context",
			roomId: "r-calendar",
			createdAt: olderCreatedAt,
			content: { text: "I have back-to-back meetings" },
		};
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("I have back-to-back meetings", {
					message: olderMessage,
				} as never),
			),
		).toBe(true);
		const processor = viewContextEvaluator.processors?.[0];
		if (!processor) throw new Error("no processor");
		const olderNavigation = processor.process({
			output: { viewId: "calendar", reason: "meetings" },
			message: olderMessage,
			runtime: { reportError },
		} as never);
		await listStarted.promise;

		const newerMessage = {
			id: "m-explicit-notes",
			roomId: "r-notes",
			createdAt: ++nextTurn,
			content: { text: "switch to notes" },
		};
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("switch to notes", { message: newerMessage } as never),
			),
		).toBe(false);
		// The deterministic VIEWS path has already committed the newer intent.
		currentView = "notes";
		currentRevision += 1;
		releaseList.resolve();

		expect(await olderNavigation).toBeUndefined();
		expect(currentView).toBe("notes");
		expect(navigated).toEqual([]);
		// Global acceptance ownership rejects the stale turn even across rooms; it
		// never starts a second current-view read or navigation.
		expect(currentReads).toBe(1);
	});

	it("keeps turn ownership independent for two clients sharing one room", async () => {
		const { navigated } = mockLoopback({ current: "chat" });
		const sharedRoom = "shared-room";
		const shellA = {
			...turnMessage("I have back-to-back meetings", sharedRoom),
			metadata: { type: "message", clientId: "shell-a" },
		};
		const shellB = {
			...turnMessage("I keep getting distracted while working", sharedRoom),
			metadata: { type: "message", clientId: "shell-b" },
		};

		expect(
			await viewContextEvaluator.shouldRun(
				ctx("I have back-to-back meetings", { message: shellA } as never),
			),
		).toBe(true);
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("I keep getting distracted while working", {
					message: shellB,
				} as never),
			),
		).toBe(true);

		const processor = viewContextEvaluator.processors?.[0];
		if (!processor) throw new Error("no processor");
		await expect(
			processor.process({
				output: { viewId: "calendar", reason: "meetings" },
				message: shellA,
				runtime: { reportError },
			} as never),
		).resolves.toMatchObject({
			success: true,
			values: { contextualView: "calendar" },
		});

		expect(navigated).toEqual(["calendar"]);
		const fetchCalls = vi.mocked(globalThis.fetch).mock.calls;
		for (const [, init] of fetchCalls) {
			expect(new Headers(init?.headers).get("X-ElizaOS-Client-Id")).toBe(
				"shell-a",
			);
		}
		const navigateCall = fetchCalls.find(([url]) =>
			String(url).includes("/api/views/calendar/navigate"),
		);
		expect(navigateCall).toBeDefined();
		expect(JSON.parse(String(navigateCall?.[1]?.body))).toMatchObject({
			clientId: "shell-a",
		});
	});

	it("expires inactive client ownership on the shared view-scope lease", async () => {
		const listStarted = deferred<void>();
		const releaseList = deferred<void>();
		const navigated: string[] = [];
		const now = vi.spyOn(Date, "now").mockReturnValue(100_000);

		vi.mocked(globalThis.fetch).mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/api/views/current")) {
				return Response.json({ currentView: null, revision: 1 });
			}
			if (u.endsWith("/api/views")) {
				listStarted.resolve();
				await releaseList.promise;
				return Response.json({
					views: REGISTERED_VIEW_IDS.map(viewSummary),
				});
			}
			const nav = /\/api\/views\/([^/?]+)\/navigate/.exec(u);
			if (nav) {
				navigated.push(decodeURIComponent(nav[1]));
				return new Response(null, { status: 200 });
			}
			throw new Error(`unexpected request: ${u}`);
		});

		const staleMessage = turnMessage(
			"I have back-to-back meetings",
			"r1",
			"stale-shell",
		);
		const processor = viewContextEvaluator.processors?.[0];
		if (!processor) throw new Error("no processor");
		const staleNavigation = processor.process(
			processorContext(
				{ viewId: "calendar", reason: "meetings" },
				staleMessage,
			),
		);
		await listStarted.promise;

		now.mockReturnValue(100_000 + VIEW_SCOPE_IDLE_TTL_MS);
		const activeMessage = turnMessage(
			"I keep getting distracted while working",
			"r1",
			"active-shell",
		);
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("I keep getting distracted while working", {
					message: activeMessage,
				}),
			),
		).toBe(true);

		releaseList.resolve();
		expect(await staleNavigation).toBeUndefined();
		expect(navigated).toEqual([]);
	});

	it("evicts least-recently-observed client ownership at the hard bound", async () => {
		const listStarted = deferred<void>();
		const releaseList = deferred<void>();
		const navigated: string[] = [];

		vi.mocked(globalThis.fetch).mockImplementation(async (url: unknown) => {
			const u = String(url);
			if (u.endsWith("/api/views/current")) {
				return Response.json({ currentView: null, revision: 1 });
			}
			if (u.endsWith("/api/views")) {
				listStarted.resolve();
				await releaseList.promise;
				return Response.json({
					views: REGISTERED_VIEW_IDS.map(viewSummary),
				});
			}
			const nav = /\/api\/views\/([^/?]+)\/navigate/.exec(u);
			if (nav) {
				navigated.push(decodeURIComponent(nav[1]));
				return new Response(null, { status: 200 });
			}
			throw new Error(`unexpected request: ${u}`);
		});

		const oldestMessage = turnMessage(
			"I have back-to-back meetings",
			"r1",
			"oldest-shell",
		);
		const processor = viewContextEvaluator.processors?.[0];
		if (!processor) throw new Error("no processor");
		const oldestNavigation = processor.process(
			processorContext(
				{ viewId: "calendar", reason: "meetings" },
				oldestMessage,
			),
		);
		await listStarted.promise;

		for (let index = 0; index < 300; index += 1) {
			const message = turnMessage(
				"I keep getting distracted while working",
				"r1",
				`bounded-shell-${index}`,
			);
			expect(
				await viewContextEvaluator.shouldRun(
					ctx("I keep getting distracted while working", {
						message,
					}),
				),
			).toBe(true);
		}

		releaseList.resolve();
		expect(await oldestNavigation).toBeUndefined();
		expect(navigated).toEqual([]);
	});

	it("lets the server reject a stale navigation that races after the final preflight", async () => {
		let currentView = "chat";
		let revision = 70;
		let currentReads = 0;
		const attempted: string[] = [];
		const accepted: string[] = [];

		vi.mocked(globalThis.fetch).mockImplementation(
			async (url: unknown, init?: RequestInit) => {
				const u = String(url);
				if (u.endsWith("/api/views/current")) {
					currentReads += 1;
					const snapshotView = currentView;
					const snapshotRevision = revision;
					const readNumber = currentReads;
					return {
						ok: true,
						status: 200,
						json: async () => {
							if (readNumber === 2) {
								currentView = "notes";
								revision += 1;
							}
							return {
								currentView: {
									viewId: snapshotView,
									viewPath: `/${snapshotView}`,
									viewLabel: snapshotView,
									viewType: "gui",
									updatedAt: "2026-07-17T12:00:00.000Z",
								},
								revision: snapshotRevision,
							};
						},
					} as Response;
				}
				if (u.endsWith("/api/views")) {
					return {
						ok: true,
						status: 200,
						json: async () => ({ views: REGISTERED_VIEW_IDS.map(viewSummary) }),
					} as Response;
				}
				const nav = /\/api\/views\/([^/?]+)\/navigate/.exec(u);
				if (nav) {
					const target = decodeURIComponent(nav[1]);
					attempted.push(target);
					const body = JSON.parse(String(init?.body)) as {
						expectedRevision?: number;
					};
					if (body.expectedRevision !== revision) {
						return { ok: false, status: 409 } as Response;
					}
					accepted.push(target);
					currentView = target;
					revision += 1;
					return { ok: true, status: 200 } as Response;
				}
				throw new Error(`unexpected request: ${u}`);
			},
		);

		const result = await runProcessor({
			viewId: "calendar",
			reason: "meetings",
		});

		expect(result).toBeUndefined();
		expect(attempted).toEqual(["calendar"]);
		expect(accepted).toEqual([]);
		expect(currentView).toBe("notes");
	});

	it("fails closed when a contextual turn lacks an acceptance timestamp", async () => {
		const message = {
			id: "m-without-created-at",
			roomId: "r-missing-time",
			content: { text: "fix the login bug" },
		};

		expect(
			await viewContextEvaluator.shouldRun(
				ctx("fix the login bug", { message } as never),
			),
		).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("fails closed when two accepted turns share the same timestamp", async () => {
		const createdAt = ++nextTurn;
		const first = {
			id: "m-tied-calendar",
			roomId: "r-calendar-tie",
			createdAt,
			content: { text: "I have back-to-back meetings" },
		};
		const second = {
			id: "m-tied-focus",
			roomId: "r-focus-tie",
			createdAt,
			content: { text: "I keep getting distracted while working" },
		};

		expect(
			await viewContextEvaluator.shouldRun(
				ctx("I have back-to-back meetings", { message: first } as never),
			),
		).toBe(true);
		expect(
			await viewContextEvaluator.shouldRun(
				ctx("I keep getting distracted while working", {
					message: second,
				} as never),
			),
		).toBe(false);

		const processor = viewContextEvaluator.processors?.[0];
		if (!processor) throw new Error("no processor");
		expect(
			await processor.process({
				output: { viewId: "calendar" },
				message: first,
				runtime: { reportError },
			} as never),
		).toBeUndefined();
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});
});
