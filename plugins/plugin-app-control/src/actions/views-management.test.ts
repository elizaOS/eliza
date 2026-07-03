import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ResponseHandlerEvaluatorContext } from "@elizaos/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { viewFollowupRoutingEvaluator } from "../evaluators/view-followup-routing.js";
import { runCreate } from "./app-create.js";
import { createViewsAction, createViewsAliasAction } from "./views.js";
import type { ViewSummary } from "./views-client.js";
import { runViewsCreate } from "./views-create.js";
import { runViewsDelete } from "./views-delete.js";
import { runViewsEdit } from "./views-edit.js";

const coreMock = vi.hoisted(() => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
	ModelType: {
		TEXT_SMALL: "TEXT_SMALL",
	},
	resolveServerOnlyPort: vi.fn(() => 3456),
	// @elizaos/shared re-exports formatError (as errorMessage) from @elizaos/core,
	// and app-control imports @elizaos/shared at module load — the mock must carry it.
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
		) =>
			run({
				parentStepId: "parent-step-1",
				linkChild: vi.fn(async () => {}),
			}),
	),
	hasOwnerAccess: vi.fn(async () => true),
}));

vi.mock("@elizaos/core", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@elizaos/core")>();
	return {
		...coreMock,
		getUserMessageText: actual.getUserMessageText,
	};
});

type RuntimeTask = {
	id: string;
	metadata?: Record<string, unknown>;
};

function message(text: string, roomId = "room-1") {
	return {
		entityId: "user-1",
		roomId,
		agentId: "agent-1",
		content: { text },
	};
}

function composedViewPrompt(userRequest: string) {
	return [
		"Answer the user request using the contextual documents below as the source of truth.",
		"",
		"<contextual_documents>",
		'<source title="source-1" similarity="1.000">',
		"Route chat through Cloud and configure purchase-share settings.",
		"</source>",
		"</contextual_documents>",
		"",
		"<user_request>",
		userRequest,
		"</user_request>",
	].join("\n");
}

function view(patch: Partial<ViewSummary> = {}): ViewSummary {
	return {
		id: "remote-ledger",
		label: "Remote Ledger",
		description: "Track remote balances",
		available: true,
		pluginName: "@local/plugin-ledger",
		path: "/views/remote-ledger",
		tags: ["ledger"],
		viewType: "gui",
		...patch,
	};
}

function createRuntime({
	tasks = [],
	modelText = "name: remote-ledger\ndisplayName: Remote Ledger",
}: {
	tasks?: RuntimeTask[];
	modelText?: string;
} = {}) {
	const codingHandler = vi.fn(async () => ({
		success: true,
		text: "started",
		data: {
			agents: [
				{
					sessionId: "task-session-1",
					agentType: "coding",
					workdir: "/tmp/workdir",
					label: "view-task",
					status: "running",
				},
			],
		},
	}));
	const runtime = {
		agentId: "agent-1",
		actions: [{ name: "START_CODING_TASK", handler: codingHandler }],
		// Declare a configured coding backend so the create-flow dispatch
		// preflight stays deterministic on hosts without a coding CLI on PATH.
		getSetting: vi.fn((key: string) =>
			key === "ELIZA_ACP_DEFAULT_AGENT" ? "claude" : undefined,
		),
		useModel: vi.fn(async () => modelText),
		getTasks: vi.fn(async () => tasks),
		createTask: vi.fn(async (task: unknown) => {
			tasks.push({
				id: `task-${tasks.length + 1}`,
				metadata:
					typeof task === "object" && task !== null && "metadata" in task
						? ((task as { metadata?: Record<string, unknown> }).metadata ?? {})
						: {},
			});
		}),
		deleteTask: vi.fn(async (taskId: string) => {
			const index = tasks.findIndex((task) => task.id === taskId);
			if (index >= 0) tasks.splice(index, 1);
		}),
	};
	return { runtime, codingHandler, tasks };
}

function evaluatorContext(
	text: string,
	overrides: Partial<ResponseHandlerEvaluatorContext> = {},
): ResponseHandlerEvaluatorContext {
	return {
		runtime: {
			agentId: "agent-1",
			actions: [{ name: "VIEWS" }],
			logger: coreMock.logger,
		},
		message: message(text) as never,
		state: {},
		messageHandler: {
			processMessage: "RESPOND",
			thought: "direct reply",
			plan: {
				contexts: ["simple"],
				requiresTool: false,
				reply: "Sure, what should the note be titled?",
			},
		},
		availableContexts: [{ id: "general" }, { id: "simple" }],
		...overrides,
	} as ResponseHandlerEvaluatorContext;
}

function createRepoFixture() {
	const repoRoot = mkdtempSync(path.join(tmpdir(), "views-actions-"));
	const templateDir = path.join(
		repoRoot,
		"packages/elizaos/templates/min-plugin",
	);
	const pluginsDir = path.join(repoRoot, "plugins");
	mkdirSync(path.join(templateDir, "src"), { recursive: true });
	mkdirSync(pluginsDir, { recursive: true });
	writeFileSync(
		path.join(templateDir, "package.json"),
		JSON.stringify({
			name: "@local/plugin-__PLUGIN_NAME__",
			displayName: "__PLUGIN_DISPLAY_NAME__",
		}),
	);
	writeFileSync(
		path.join(templateDir, "src/index.ts"),
		"export const name = '__PLUGIN_NAME__';\nexport const displayName = '__PLUGIN_DISPLAY_NAME__';\n",
	);
	return {
		repoRoot,
		pluginsDir,
		cleanup: () => rmSync(repoRoot, { recursive: true, force: true }),
	};
}

describe("view management actions", () => {
	beforeEach(() => {
		coreMock.spawnWithTrajectoryLink.mockClear();
		coreMock.resolveServerOnlyPort.mockClear();
		vi.stubGlobal("fetch", vi.fn());
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("routes active-view mutation follow-ups through VIEWS before direct reply", async () => {
		const notesView = view({
			id: "notes",
			label: "Notes",
			description: "Sticky notes board",
			tags: ["notes", "sticky-notes"],
			capabilities: [
				{
					id: "create-note",
					description: "Create a sticky note",
					params: {
						title: { type: "string", description: "Optional note title" },
						body: { type: "string", description: "Note body text" },
					},
				},
				{
					id: "delete-note",
					description: "Delete a sticky note by id, title, or query",
				},
			],
		});
		vi.mocked(globalThis.fetch).mockImplementation(async (url) => {
			const requestUrl = String(url);
			if (requestUrl.endsWith("/api/views/current")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({
						currentView: {
							viewId: "notes",
							viewPath: "/notes",
							viewLabel: "Notes",
							viewType: "gui",
							action: "open",
							updatedAt: "2026-06-08T00:00:00.000Z",
						},
					}),
				} as Response;
			}
			return {
				ok: true,
				status: 200,
				json: async () => ({ views: [notesView] }),
			} as Response;
		});

		const context = evaluatorContext(
			"can you make another one saying i need to wake up at 3am",
		);

		expect(await viewFollowupRoutingEvaluator.shouldRun(context)).toBe(true);
		await expect(
			viewFollowupRoutingEvaluator.evaluate(context),
		).resolves.toMatchObject({
			requiresTool: true,
			clearReply: true,
			reply: "On it.",
			addContexts: ["general"],
			addCandidateActions: ["VIEWS"],
			addParentActionHints: ["VIEWS"],
		});
	});

	it("leaves ordinary non-view follow-ups on the direct path", async () => {
		const context = evaluatorContext("can you make another joke", {
			messageHandler: {
				processMessage: "RESPOND",
				thought: "direct reply",
				plan: {
					contexts: ["simple"],
					requiresTool: false,
					reply: "Here's another joke.",
				},
			},
		} as never);

		expect(await viewFollowupRoutingEvaluator.shouldRun(context)).toBe(false);
		expect(globalThis.fetch).not.toHaveBeenCalled();
	});

	it("advertises UI view switching in its planner routing hint", () => {
		const action = createViewsAction();
		expect(action.routingHint).toContain("UI view/window/panel/app navigation");
		expect(action.routingHint).toContain("Close/hide means VIEWS action=close");
	});

	it("stays available when stage 1 routes a view request to a domain context", () => {
		const action = createViewsAction();
		expect(action.contexts).toEqual(
			expect.arrayContaining(["general", "calendar", "tasks", "documents"]),
		);
		expect(action.contextGate?.anyOf).toEqual(
			expect.arrayContaining(["calendar", "tasks"]),
		);
	});

	it("scaffolds a new view plugin and dispatches a coding task with the generated prompt", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime, codingHandler } = createRuntime();
			const callback = vi.fn();

			const result = await runViewsCreate({
				runtime: runtime as never,
				message: message("create a remote ledger dashboard view") as never,
				views: [],
				callback,
				repoRoot: repo.repoRoot,
			});

			const workdir = path.join(repo.pluginsDir, "plugin-remote-ledger");
			expect(result.success).toBe(true);
			expect(result.values).toMatchObject({
				mode: "create",
				subMode: "new",
				name: "remote-ledger",
				displayName: "Remote Ledger",
				workdir,
				taskSessionId: "task-session-1",
			});
			expect(
				readFileSync(path.join(workdir, "src/index.ts"), "utf8"),
			).toContain("Remote Ledger");
			expect(codingHandler).toHaveBeenCalledTimes(1);
			const handlerOptions = codingHandler.mock.calls[0][3] as {
				parameters: Record<string, unknown>;
			};
			expect(handlerOptions.parameters.label).toBe("create-view:remote-ledger");
			expect(handlerOptions.parameters.task).toContain(
				"task: build_eliza_plugin_with_view",
			);
			expect(handlerOptions.parameters.task).toContain(
				"completionRule: after all commands pass",
			);
			expect(handlerOptions.parameters.metadata).toMatchObject({
				originRoomId: "room-1",
				parentTrajectoryStepId: "parent-step-1",
				trajectoryLinkSource: "plugin-app-control:views-create",
			});
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining("Started view create task"),
				}),
			);
		} finally {
			repo.cleanup();
		}
	});

	it("resolves an existing view to a local plugin directory and dispatches an edit task", async () => {
		const repo = createRepoFixture();
		try {
			const pluginDir = path.join(repo.pluginsDir, "plugin-ledger");
			mkdirSync(pluginDir, { recursive: true });
			const { runtime, codingHandler } = createRuntime();

			const result = await runViewsEdit({
				runtime: runtime as never,
				message: message("update the remote ledger title") as never,
				options: {
					view: "remote-ledger",
					intent: "rename the title to Remote Ledger Updated",
				},
				views: [view()],
				callback: vi.fn(),
				repoRoot: repo.repoRoot,
			});

			expect(result.success).toBe(true);
			expect(result.values).toMatchObject({
				mode: "edit",
				viewId: "remote-ledger",
				workdir: pluginDir,
				taskSessionId: "task-session-1",
			});
			expect(codingHandler).toHaveBeenCalledTimes(1);
			const handlerOptions = codingHandler.mock.calls[0][3] as {
				parameters: Record<string, unknown>;
			};
			expect(handlerOptions.parameters.label).toBe("edit-view:remote-ledger");
			expect(handlerOptions.parameters.task).toContain(
				"task: edit_eliza_plugin_view",
			);
			expect(handlerOptions.parameters.task).toContain(
				"rename the title to Remote Ledger Updated",
			);
			expect(handlerOptions.parameters.metadata).toMatchObject({
				originRoomId: "room-1",
				parentTrajectoryStepId: "parent-step-1",
				trajectoryLinkSource: "plugin-app-control:views-edit",
			});
		} finally {
			repo.cleanup();
		}
	});

	it("requires a structured target before deleting a view", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime } = createRuntime();
			const callback = vi.fn();

			const result = await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the remote ledger view") as never,
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(result.success).toBe(false);
			expect(result.text).toContain("structured view");
			expect(runtime.createTask).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			repo.cleanup();
		}
	});

	it("requires structured confirmation before deleting a view and unloads the plugin after confirm=true", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime, tasks } = createRuntime();
			const callback = vi.fn();

			const first = await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the remote ledger view") as never,
				options: { view: "remote-ledger" },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(first.success).toBe(true);
			expect(first.values).toMatchObject({
				mode: "delete",
				subMode: "confirm",
				viewId: "remote-ledger",
				pluginName: "@local/plugin-ledger",
			});
			expect(runtime.createTask).toHaveBeenCalledWith(
				expect.objectContaining({
					name: "VIEWS_DELETE confirm",
					tags: ["views-delete-confirm"],
					metadata: expect.objectContaining({
						roomId: "room-1",
						viewId: "remote-ledger",
						pluginName: "@local/plugin-ledger",
					}),
				}),
			);
			expect(globalThis.fetch).not.toHaveBeenCalled();

			const textOnlyReply = await runViewsDelete({
				runtime: runtime as never,
				message: message("yes") as never,
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(textOnlyReply.success).toBe(false);
			expect(textOnlyReply.text).toContain("confirm=true");
			expect(runtime.deleteTask).not.toHaveBeenCalled();
			expect(tasks).toHaveLength(1);
			expect(globalThis.fetch).not.toHaveBeenCalled();

			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					pluginName: "@local/plugin-ledger",
					message: "@local/plugin-ledger uninstalled.",
				}),
			} as Response);

			const second = await runViewsDelete({
				runtime: runtime as never,
				message: message("sí") as never,
				options: { confirm: true },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(second.success).toBe(true);
			expect(second.values).toMatchObject({
				mode: "delete",
				viewId: "remote-ledger",
				pluginName: "@local/plugin-ledger",
			});
			expect(runtime.deleteTask).toHaveBeenCalledWith("task-1");
			expect(tasks).toEqual([]);
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/plugins/uninstall",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ name: "@local/plugin-ledger" }),
				}),
			);
			expect(second.text).toContain("uninstalled");
		} finally {
			repo.cleanup();
		}
	});

	it("owner-gates the follow-up delete confirmation turn for a non-owner (#10471)", async () => {
		// A pending delete-confirm task exists in this room. A non-owner replying
		// with a structured confirm must NOT be able to confirm someone else's
		// destructive delete — validate must funnel the follow-up turn through the
		// owner gate, exactly like the first destructive turn.
		const { runtime } = createRuntime({
			tasks: [
				{
					id: "task-1",
					metadata: {
						roomId: "room-1",
						viewId: "remote-ledger",
						viewLabel: "Remote Ledger",
						pluginName: "@local/plugin-ledger",
					},
				},
			],
		});
		const ownerCheck = vi.fn(async () => false);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: ownerCheck,
		});

		await expect(
			action.validate?.(runtime as never, message("yes") as never, undefined, {
				confirm: true,
			}),
		).resolves.toBe(false);
		// The gate was actually reached (not rejected for some earlier reason).
		expect(ownerCheck).toHaveBeenCalledTimes(1);

		// A structured cancel from a non-owner is gated the same way.
		await expect(
			action.validate?.(runtime as never, message("no") as never, undefined, {
				confirm: false,
			}),
		).resolves.toBe(false);
		expect(ownerCheck).toHaveBeenCalledTimes(2);
	});

	it("reports failure (not 'Deleted') when the plugin uninstall fails", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime } = createRuntime();
			const callback = vi.fn();

			await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the remote ledger view") as never,
				options: { view: "remote-ledger" },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			// The uninstall route ran but reported failure (e.g. a bundled/core
			// plugin). Delete must surface that, not claim the plugin was removed.
			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: false,
				status: 422,
				json: async () => ({ ok: false, error: "plugin is bundled" }),
			} as Response);

			const second = await runViewsDelete({
				runtime: runtime as never,
				message: message("confirmo") as never,
				options: { confirm: true },
				views: [view()],
				callback,
				repoRoot: repo.repoRoot,
			});

			expect(second.success).toBe(false);
			expect(second.text).not.toContain("Deleted");
			expect(second.text).toContain("partially failed");
			expect(second.text).toContain("plugin is bundled");
		} finally {
			repo.cleanup();
		}
	});

	it("refuses to delete protected first-party view plugins", async () => {
		const repo = createRepoFixture();
		try {
			const { runtime } = createRuntime();

			const result = await runViewsDelete({
				runtime: runtime as never,
				message: message("delete the app control view") as never,
				options: { view: "@elizaos/plugin-app-control" },
				views: [
					view({
						id: "app-control",
						label: "App Control",
						pluginName: "@elizaos/plugin-app-control",
					}),
				],
				callback: vi.fn(),
				repoRoot: repo.repoRoot,
			});

			expect(result.success).toBe(false);
			expect(result.text).toContain("protected first-party plugin");
			expect(runtime.createTask).not.toHaveBeenCalled();
			expect(globalThis.fetch).not.toHaveBeenCalled();
		} finally {
			repo.cleanup();
		}
	});

	it("opens a view in a separate always-on-top window through the shell navigate API", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const client = {
			listViews: vi.fn(async () => [view()]),
			getCurrentView: vi.fn(async () => null),
		};
		const action = createViewsAction({
			client,
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);
		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				"open the remote ledger view in a separate always on top window",
			) as never,
			undefined,
			{
				action: "window",
				view: "remote-ledger",
				alwaysOnTop: true,
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "window",
			viewId: "remote-ledger",
			viewType: "gui",
			alwaysOnTop: true,
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/remote-ledger/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					alwaysOnTop: true,
				}),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: 'Opened gui view "remote-ledger" in a separate window.',
			}),
		);
	});

	it("resolves existing registered view targets for natural-language window and pin requests", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "orchestrator",
						label: "Orchestrator",
						path: "/orchestrator",
					}),
					view({
						id: "views-manager",
						label: "Views",
						path: "/views",
						tags: ["views-manager"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);

		const windowResult = await action.handler(
			runtime as never,
			message("open orchestrator in a new window") as never,
			undefined,
			undefined,
			callback,
		);

		expect(windowResult?.success).toBe(true);
		expect(windowResult?.values).toMatchObject({
			mode: "window",
			viewId: "orchestrator",
			viewType: "gui",
			alwaysOnTop: false,
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					alwaysOnTop: false,
				}),
			}),
		);

		const openActionWindowResult = await action.handler(
			runtime as never,
			message("open orchestrator in a new window") as never,
			undefined,
			{
				action: "open",
				view: "orchestrator",
			},
			callback,
		);

		expect(openActionWindowResult?.success).toBe(true);
		expect(openActionWindowResult?.values).toMatchObject({
			mode: "window",
			viewId: "orchestrator",
			viewType: "gui",
			alwaysOnTop: false,
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					alwaysOnTop: false,
				}),
			}),
		);

		const pinResult = await action.handler(
			runtime as never,
			message("pin views manager as a tab") as never,
			undefined,
			undefined,
			callback,
		);

		expect(pinResult?.success).toBe(true);
		expect(pinResult?.values).toMatchObject({
			mode: "pin",
			viewId: "views-manager",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/views-manager/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "pin-tab",
					alwaysOnTop: false,
				}),
			}),
		);

		const explicitPinResult = await action.handler(
			runtime as never,
			message("pin views manager as a tab") as never,
			undefined,
			{
				action: "pin",
				view: "views manager",
			},
			callback,
		);

		expect(explicitPinResult?.success).toBe(true);
		expect(explicitPinResult?.values).toMatchObject({
			mode: "pin",
			viewId: "views-manager",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/views-manager/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "pin-tab",
					alwaysOnTop: false,
				}),
			}),
		);

		const pollutedSplitResult = await action.handler(
			runtime as never,
			message("split orchestrator and views manager side by side") as never,
			undefined,
			{
				action: "split",
				views: ["orchestrator", "views manager", "chat", "settings"],
			},
			callback,
		);

		expect(pollutedSplitResult?.success).toBe(true);
		expect(pollutedSplitResult?.values).toMatchObject({
			mode: "split",
			viewIds: ["orchestrator", "views-manager"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["orchestrator", "views-manager"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it("routes split and tile requests through the shell layout navigate API", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		// Two layout calls (split, then tile) → queue two navigate responses.
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);

		const splitResult = await action.handler(
			runtime as never,
			message("split notes and calendar side by side") as never,
			undefined,
			undefined,
			callback,
		);

		expect(splitResult?.success).toBe(true);
		expect(splitResult?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Split views: Notes, Calendar (horizontal).",
			}),
		);

		const tileResult = await action.handler(
			runtime as never,
			message("tile my simple views") as never,
			undefined,
			{
				action: "tile",
				views: ["notes", "calendar"],
			},
			callback,
		);

		expect(tileResult?.success).toBe(true);
		expect(tileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["notes", "calendar"],
			layout: "grid",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["notes", "calendar"],
					layout: "grid",
				}),
			}),
		);
	});

	it("routes existing registered view layout requests without simple-view targets", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "chat",
						label: "Chat",
						path: "/chat",
					}),
					view({
						id: "settings",
						label: "Settings",
						path: "/settings",
					}),
					view({
						id: "orchestrator",
						label: "Orchestrator",
						path: "/orchestrator",
					}),
					view({
						id: "views-manager",
						label: "Views",
						path: "/views",
						tags: ["views-manager"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		// This test exercises four layout handler calls (split, tile, planner-partial
		// tile, bad-split-mode tile); each issues one navigate POST, so queue four
		// successful navigate responses. (Previously only three were queued and the
		// fourth call silently received `undefined` from the bare fetch mock — it
		// passed only because the helper hardcoded success:true regardless of the
		// transport result, which is the bug this change fixes.)
		vi.mocked(globalThis.fetch)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response)
			.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ ok: true }),
			} as Response);

		const splitResult = await action.handler(
			runtime as never,
			message("split orchestrator and views manager side by side") as never,
			undefined,
			undefined,
			callback,
		);

		expect(splitResult?.success).toBe(true);
		expect(splitResult?.values).toMatchObject({
			mode: "split",
			viewIds: ["orchestrator", "views-manager"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["orchestrator", "views-manager"],
					layout: "horizontal",
				}),
			}),
		);

		const tileResult = await action.handler(
			runtime as never,
			message("tile chat settings orchestrator and views manager") as never,
			undefined,
			undefined,
			callback,
		);

		expect(tileResult?.success).toBe(true);
		expect(tileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["chat", "settings", "orchestrator", "views-manager"],
			layout: "grid",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["chat", "settings", "orchestrator", "views-manager"],
					layout: "grid",
				}),
			}),
		);

		const plannerPartialTileResult = await action.handler(
			runtime as never,
			message("tile chat settings orchestrator and views manager") as never,
			undefined,
			{
				action: "tile",
				views: ["orchestrator", "views manager"],
			},
			callback,
		);

		expect(plannerPartialTileResult?.success).toBe(true);
		expect(plannerPartialTileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["chat", "settings", "orchestrator", "views-manager"],
			layout: "grid",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["chat", "settings", "orchestrator", "views-manager"],
					layout: "grid",
				}),
			}),
		);

		const badSplitModeTileResult = await action.handler(
			runtime as never,
			message("tile chat settings orchestrator and views manager") as never,
			undefined,
			{
				action: "split",
				views: ["orchestrator", "views manager"],
			},
			callback,
		);

		expect(badSplitModeTileResult?.success).toBe(true);
		expect(badSplitModeTileResult?.values).toMatchObject({
			mode: "tile",
			viewIds: ["chat", "settings", "orchestrator", "views-manager"],
			layout: "grid",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "tile-views",
					views: ["chat", "settings", "orchestrator", "views-manager"],
					layout: "grid",
				}),
			}),
		);
	});

	it("uses the composed user_request block for layout target extraction", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "chat",
						label: "Chat",
						path: "/chat",
					}),
					view({
						id: "settings",
						label: "Settings",
						path: "/settings",
					}),
					view({
						id: "orchestrator",
						label: "Orchestrator",
						path: "/orchestrator",
					}),
					view({
						id: "views-manager",
						label: "Views",
						path: "/views",
						tags: ["views-manager"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				composedViewPrompt("split orchestrator and views manager side by side"),
			) as never,
			undefined,
			{
				action: "split",
				views: ["orchestrator", "views manager"],
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["orchestrator", "views-manager"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenLastCalledWith(
			"http://127.0.0.1:3456/api/views/orchestrator/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["orchestrator", "views-manager"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it('treats "next to it" as split even when the planner passes action=open', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui",
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			{ action: "open", view: "calendar" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it("does not add the current chat view when split targets already include two explicit views", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "chat", label: "Chat", path: "/" }),
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "notepad"],
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "chat",
					viewLabel: "Chat",
					viewType: "gui",
					viewPath: "/",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			{
				action: "split",
				mode: "split",
				view: "notepad",
				views: ["notepad", "calendar"],
				layout: "horizontal",
				placement: "right",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
			placement: "right",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
					placement: "right",
				}),
			}),
		);
	});

	it('treats "next to it" as split even when the planner passes action=tile', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "notepad"],
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			{
				action: "tile",
				views: ["notepad", "calendar"],
				layout: "horizontal",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it('routes "open <name> view" to show/navigate, not the current-view query', async () => {
		// Regression: CURRENT_VIEW_VERBS once included "open", so "open wallet
		// view" matched current before show and reported the active view instead
		// of navigating. inferMode must resolve this to a show/navigate.
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const getCurrentView = vi.fn(async () => null);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view({ id: "wallet", label: "Wallet" })]),
				getCurrentView,
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			text: async () => "",
		} as Response);

		// No explicit action option — this exercises inferMode on the raw text.
		const result = await action.handler(
			runtime as never,
			message("open the wallet view") as never,
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({ mode: "show", viewId: "wallet" });
		// A current-view query would have hit getCurrentView instead of navigate.
		expect(getCurrentView).not.toHaveBeenCalled();
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/wallet/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("owner-gates mutating view management modes but allows window navigation validation", async () => {
		const { runtime } = createRuntime();
		const ownerCheck = vi.fn(async () => false);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: ownerCheck,
		});

		await expect(
			action.validate?.(
				runtime as never,
				message("create a remote ledger dashboard view") as never,
			),
		).resolves.toBe(false);
		await expect(
			action.validate?.(
				runtime as never,
				message("edit the remote ledger view") as never,
			),
		).resolves.toBe(false);
		await expect(
			action.validate?.(
				runtime as never,
				message("delete the remote ledger view") as never,
			),
		).resolves.toBe(false);
		await expect(
			action.validate?.(
				runtime as never,
				message("open the remote ledger view in a separate window") as never,
			),
		).resolves.toBe(true);
		expect(ownerCheck).toHaveBeenCalledTimes(3);
	});

	it("owner-gates the rollback sub-mode like other mutating modes (#8915)", async () => {
		const { runtime } = createRuntime();
		const ownerCheck = vi.fn(async () => false);
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: ownerCheck,
		});

		// Explicit action=rollback is owner-gated.
		await expect(
			action.validate?.(
				runtime as never,
				message("rollback") as never,
				undefined,
				{ action: "rollback" },
			),
		).resolves.toBe(false);
		// Natural-language rollback phrasing is owner-gated too.
		await expect(
			action.validate?.(
				runtime as never,
				message("roll back the remote ledger plugin") as never,
			),
		).resolves.toBe(false);
		expect(ownerCheck).toHaveBeenCalledTimes(2);
	});

	it("routes action=rollback to the rollback handler and reports no snapshot when none recorded (#8915)", async () => {
		// No snapshot tasks recorded -> rollback short-circuits before any git/fetch,
		// proving the dispatcher wired the rollback sub-mode in.
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		const result = await action.handler(
			runtime as never,
			message("rollback the remote ledger plugin") as never,
			undefined,
			{ action: "rollback" },
			callback,
		);

		expect(result?.success).toBe(false);
		expect(result?.text?.toLowerCase()).toContain("no pre-edit snapshot");
		// rollback never touched git/fetch when there's nothing to roll back.
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(runtime.getTasks).toHaveBeenCalled();
	});

	it("includes explicit TUI view type and always-on-top false in window navigation payloads", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view({ viewType: "tui" })]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				"open the remote ledger terminal view in a separate window",
			) as never,
			undefined,
			{
				action: "window",
				view: "remote-ledger",
				viewType: "tui",
				alwaysOnTop: false,
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "window",
			viewId: "remote-ledger",
			viewType: "tui",
			alwaysOnTop: false,
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/remote-ledger/navigate?viewType=tui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					viewType: "tui",
					alwaysOnTop: false,
				}),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: 'Opened tui view "remote-ledger" in a separate window.',
			}),
		);
	});

	it("includes explicit XR view type in window navigation payloads", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view({ viewType: "xr" })]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message(
				"open the remote ledger spatial view in a separate window",
			) as never,
			undefined,
			{
				action: "window",
				view: "remote-ledger",
				viewType: "xr",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "window",
			viewId: "remote-ledger",
			viewType: "xr",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/remote-ledger/navigate?viewType=xr",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "open-window",
					viewType: "xr",
					alwaysOnTop: false,
				}),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: 'Opened xr view "remote-ledger" in a separate window.',
			}),
		);
	});

	it("routes create, edit, and delete through the unified VIEWS action dispatcher", async () => {
		const repo = createRepoFixture();
		try {
			const pluginDir = path.join(repo.pluginsDir, "plugin-ledger");
			mkdirSync(pluginDir, { recursive: true });
			const { runtime, codingHandler } = createRuntime();
			const callback = vi.fn();
			let registeredViews: ViewSummary[] = [];
			const client = {
				listViews: vi.fn(async () => registeredViews),
				getCurrentView: vi.fn(async () => null),
			};
			const action = createViewsAction({
				client,
				hasOwnerAccess: vi.fn(async () => true),
				repoRoot: repo.repoRoot,
			});

			const createResult = await action.handler(
				runtime as never,
				message("create a remote ledger dashboard view") as never,
				undefined,
				{ action: "create", intent: "remote ledger dashboard" },
				callback,
			);

			expect(createResult?.success).toBe(true);
			expect(createResult?.values).toMatchObject({
				mode: "create",
				subMode: "new",
				name: "remote-ledger",
			});
			expect(codingHandler).toHaveBeenCalledTimes(1);
			expect(client.listViews).toHaveBeenCalledTimes(1);

			registeredViews = [view()];
			const editResult = await action.handler(
				runtime as never,
				message("edit the remote ledger view") as never,
				undefined,
				{
					action: "edit",
					intent: "rename the title to Remote Ledger Updated",
					view: "remote-ledger",
				},
				callback,
			);

			expect(editResult?.success).toBe(true);
			expect(editResult?.values).toMatchObject({
				mode: "edit",
				viewId: "remote-ledger",
				workdir: pluginDir,
			});
			expect(codingHandler).toHaveBeenCalledTimes(2);

			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					ok: true,
					pluginName: "@local/plugin-ledger",
					message: "@local/plugin-ledger uninstalled.",
				}),
			} as Response);

			const deleteResult = await action.handler(
				runtime as never,
				message("delete the remote ledger view") as never,
				undefined,
				{
					action: "delete",
					confirm: true,
					view: "remote-ledger",
				},
				callback,
			);

			expect(deleteResult?.success).toBe(true);
			expect(deleteResult?.values).toMatchObject({
				mode: "delete",
				viewId: "remote-ledger",
				pluginName: "@local/plugin-ledger",
			});
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"http://127.0.0.1:3456/api/plugins/uninstall",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ name: "@local/plugin-ledger" }),
				}),
			);
			expect(callback).toHaveBeenCalledWith(
				expect.objectContaining({
					text: expect.stringContaining("Deleted Remote Ledger"),
				}),
			);
		} finally {
			repo.cleanup();
		}
	});

	it("routes explicit CLOSE_VIEW alias calls through non-destructive view close", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const client = {
			listViews: vi.fn(async () => [
				view({ id: "settings", label: "Settings", path: "/settings" }),
			]),
			getCurrentView: vi.fn(async () => null),
		};
		const action = createViewsAliasAction("CLOSE_VIEW", {
			client,
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("close settings") as never,
			undefined,
			{ target: "settings" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "close",
			viewId: "settings",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/settings/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: "close", alwaysOnTop: false }),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "Closed Settings." }),
		);
		expect(client.getCurrentView).not.toHaveBeenCalled();
	});

	it('treats VIEWS action=delete for "close all views" as close-all, not plugin deletion', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [view()]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("close all views") as never,
			undefined,
			{ action: "delete", mode: "delete", confirm: true },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "close",
			scope: "all",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/__all__/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: "close-all", alwaysOnTop: false }),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "Closed all views." }),
		);
	});

	it('treats action=delete for "close calendar view" as non-destructive close', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const client = {
			listViews: vi.fn(async () => [
				view({ id: "calendar", label: "Calendar", path: "/calendar" }),
			]),
			getCurrentView: vi.fn(async () => null),
		};
		const action = createViewsAction({
			client,
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("close the calendar view") as never,
			undefined,
			{ action: "delete", mode: "delete", view: "calendar", confirm: true },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "close",
			viewId: "calendar",
			viewType: "gui",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({ action: "close", alwaysOnTop: false }),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({ text: "Closed Calendar." }),
		);
		expect(client.getCurrentView).not.toHaveBeenCalled();
	});

	it('resolves casual aliases like "notepad" and "calender" for view navigation', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "notepad", "sticky-notes"],
					}),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
					}),
					view({
						id: "chat",
						label: "Chat",
						path: "/chat",
						tags: ["chat", "home"],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "",
		} as Response);

		const notesResult = await action.handler(
			runtime as never,
			message("open the notepad pls") as never,
			undefined,
			undefined,
			callback,
		);
		const calendarResult = await action.handler(
			runtime as never,
			message("open the calender view") as never,
			undefined,
			undefined,
			callback,
		);
		const homeResult = await action.handler(
			runtime as never,
			message(composedViewPrompt("go home")) as never,
			undefined,
			{ action: "show", mode: "simple" },
			callback,
		);

		expect(notesResult?.success).toBe(true);
		expect(notesResult?.values).toMatchObject({
			mode: "show",
			viewId: "notes",
		});
		expect(calendarResult?.success).toBe(true);
		expect(calendarResult?.values).toMatchObject({
			mode: "show",
			viewId: "calendar",
		});
		expect(homeResult?.success).toBe(true);
		expect(homeResult?.values).toMatchObject({
			mode: "show",
			viewId: "chat",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({ method: "POST" }),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/navigate",
			expect.objectContaining({ method: "POST" }),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/chat/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("opens the plugins page from plugin-browser aliases", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "plugins-page",
						label: "Plugins",
						path: "/apps/plugins",
						tags: [
							"plugins",
							"plugin-browser",
							"plugin browser",
							"plugin-manager",
						],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			text: async () => "",
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("open plugin browser") as never,
			undefined,
			{ action: "open", view: "plugin-browser" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "show",
			viewId: "plugins-page",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({ method: "POST" }),
		);
	});

	it("dispatches generated capability action names through the registered view catalog", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "notes",
						label: "Notes",
						path: "/notes",
						tags: ["notes", "note wall", "sticky notes"],
						capabilities: [
							{
								id: "create-note",
								description: "Create a sticky note.",
								params: {
									title: { type: "string", description: "Note title." },
									body: { type: "string", description: "Note body." },
								},
							},
							{
								id: "get-notes",
								description: "Return all sticky notes as structured data.",
							},
							{
								id: "delete-note",
								description: "Delete one sticky note by id, title, or query.",
								params: {
									id: { type: "string", description: "Note id." },
									title: {
										type: "string",
										description: "Exact note title.",
									},
									query: {
										type: "string",
										description: "Title/body search query.",
									},
									name: {
										type: "string",
										description: "Alias for title or query.",
									},
								},
							},
							{
								id: "list-elements",
								description: "List mounted view elements.",
							},
						],
					}),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "events"],
						capabilities: [
							{
								id: "get-calendar-state",
								description:
									"Return selected date and all calendar events as structured data.",
							},
							{
								id: "create-calendar-event",
								description: "Create a calendar event.",
								params: {
									title: { type: "string", description: "Event title." },
									date: {
										type: "string",
										description: "Date in YYYY-MM-DD format.",
									},
									time: { type: "string", description: "Time label." },
								},
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewType: "gui" as const,
					viewPath: "/notes",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValue({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { text: "Created.", success: true },
			}),
		} as Response);

		const noteResult = await action.handler(
			runtime as never,
			message("create note") as never,
			undefined,
			{
				action: "CREATE_NOTE",
				title: "smoke note",
				body: "created from routing",
			},
			callback,
		);
		const plannerCreateResult = await action.handler(
			runtime as never,
			message(
				"create a note titled smoke note with body created from routing",
			) as never,
			undefined,
			{
				action: "create",
				view: "smoke note",
				intent: "Note titled smoke note with body created from routing.",
			},
			callback,
		);
		const showNotesResult = await action.handler(
			runtime as never,
			message("show me my notes") as never,
			undefined,
			{ action: "show", view: "notes" },
			callback,
		);
		const listNotesAliasResult = await action.handler(
			runtime as never,
			message("show me my notes") as never,
			undefined,
			{ action: "interact", view: "notes", capability: "list-notes" },
			callback,
		);
		const deleteNoteResult = await action.handler(
			runtime as never,
			message("delete note") as never,
			undefined,
			{ action: "DELETE_NOTE", id: "note-123" },
			callback,
		);
		const deleteNoteByTextResult = await action.handler(
			runtime as never,
			message("delete the nubby note") as never,
			undefined,
			{ action: "delete" },
			callback,
		);
		const createNoteFromMessageResult = await action.handler(
			runtime as never,
			message(
				"can you make another one saying i need to wake up at 3am",
			) as never,
			undefined,
			{ action: "create" },
			callback,
		);
		const currentElementsResult = await action.handler(
			runtime as never,
			message("list elements in the current view") as never,
			undefined,
			{ action: "interact", capability: "list-elements" },
			callback,
		);
		const calendarResult = await action.handler(
			runtime as never,
			message("add a calendar event") as never,
			undefined,
			{ action: "CALENDAR_CREATE_EVENT", title: "smoke event" },
			callback,
		);
		const plannerCalendarResult = await action.handler(
			runtime as never,
			message("add a calendar event titled smoke event") as never,
			undefined,
			{
				action: "create",
				view: "calendar",
				intent: "Create event titled smoke event on 2026-06-08 at 17:00",
			},
			callback,
		);
		const explicitCapabilityWordingCalendarResult = await action.handler(
			runtime as never,
			message("create calendar event through the VIEWS capability") as never,
			undefined,
			{
				action: "create",
				view: "calendar",
				intent:
					"Create calendar event through the VIEWS capability titled routed event on 2026-06-09 at 12:00",
			},
			callback,
		);
		const camelCalendarResult = await action.handler(
			runtime as never,
			message("add a calendar event titled smoke event") as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "createEvent",
				params: {
					title: "camel event",
					date: "2026-06-08",
					time: "18:00",
				},
			},
			callback,
		);
		const listEventsResult = await action.handler(
			runtime as never,
			message("show today's calendar events") as never,
			undefined,
			{
				action: "interact",
				view: "calendar",
				capability: "list-events",
				params: { date: "2026-06-08" },
			},
			callback,
		);

		expect(noteResult?.success).toBe(true);
		expect(noteResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(plannerCreateResult?.success).toBe(true);
		expect(plannerCreateResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(showNotesResult?.success).toBe(true);
		expect(showNotesResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "get-notes",
		});
		expect(listNotesAliasResult?.success).toBe(true);
		expect(listNotesAliasResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "get-notes",
		});
		expect(deleteNoteResult?.success).toBe(true);
		expect(deleteNoteResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "delete-note",
		});
		expect(deleteNoteByTextResult?.success).toBe(true);
		expect(deleteNoteByTextResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "delete-note",
		});
		expect(createNoteFromMessageResult?.success).toBe(true);
		expect(createNoteFromMessageResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "create-note",
		});
		expect(currentElementsResult?.success).toBe(true);
		expect(currentElementsResult?.values).toMatchObject({
			mode: "interact",
			viewId: "notes",
			capability: "list-elements",
		});
		expect(calendarResult?.success).toBe(true);
		expect(calendarResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "create-calendar-event",
		});
		expect(plannerCalendarResult?.success).toBe(true);
		expect(plannerCalendarResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "create-calendar-event",
		});
		expect(explicitCapabilityWordingCalendarResult?.success).toBe(true);
		expect(explicitCapabilityWordingCalendarResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "create-calendar-event",
		});
		expect(camelCalendarResult?.success).toBe(true);
		expect(camelCalendarResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "create-calendar-event",
		});
		expect(listEventsResult?.success).toBe(true);
		expect(listEventsResult?.values).toMatchObject({
			mode: "interact",
			viewId: "calendar",
			capability: "get-calendar-state",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-note",
					params: {
						title: "smoke note",
						body: "created from routing",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-note",
					params: {
						title: "smoke note",
						body: "created from routing.",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { query: "nubby" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-note",
					params: { body: "i need to wake up at 3am" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "get-notes",
					params: undefined,
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "delete-note",
					params: { id: "note-123" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "list-elements",
					params: undefined,
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: { title: "smoke event" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: {
						title: "smoke event",
						date: "2026-06-08",
						time: "17:00",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: {
						title: "routed event",
						date: "2026-06-09",
						time: "12:00",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "create-calendar-event",
					params: {
						title: "camel event",
						date: "2026-06-08",
						time: "18:00",
					},
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/calendar/interact?viewType=gui",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					capability: "get-calendar-state",
					params: { date: "2026-06-08" },
					timeoutMs: 5_000,
					viewType: "gui",
				}),
			}),
		);
	});

	it("summarizes structured interaction results without dumping JSON into chat", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "settings",
						label: "Settings",
						path: "/settings",
						capabilities: [
							{
								id: "get-state",
								description: "Read settings state.",
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => null),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({
				success: true,
				result: { theme: "dark", language: "en" },
			}),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("get the state of settings") as never,
			undefined,
			{ action: "interact", view: "settings", capability: "get-state" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "interact",
			viewId: "settings",
			capability: "get-state",
		});
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: 'Interacted with view "settings" — capability "get-state" (returned theme, language).',
			}),
		);
		expect(callback.mock.calls[0]?.[0]?.text).not.toContain("{");
	});

	it('splits a single mentioned view "next to" the current view', async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("now open the calender view next to it") as never,
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
				}),
			}),
		);
	});

	it("splits a placed view against the current view for incremental layout requests", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("and calender on the right") as never,
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
			placement: "right",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
					placement: "right",
				}),
			}),
		);
	});

	it("uses placement orientation over stale generated capability options for placement follow-ups", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
					view({
						id: "calendar",
						label: "Calendar",
						path: "/calendar",
						tags: ["calendar", "calender"],
						capabilities: [
							{
								id: "create-calendar-event",
								description: "Create a calendar event.",
							},
						],
					}),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("and calender on the right") as never,
			undefined,
			{
				action: "create-calendar-event",
				view: "calendar",
				layout: "vertical",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.continueChain).toBe(false);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes", "calendar"],
			layout: "horizontal",
			placement: "right",
		});
		expect(globalThis.fetch).toHaveBeenCalledTimes(1);
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes", "calendar"],
					layout: "horizontal",
					placement: "right",
				}),
			}),
		);
	});

	it("reuses current split views for layout-only split follow-ups", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "plugins-page",
						label: "Plugins",
						path: "/apps/plugins",
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "plugins-page",
					viewLabel: "Plugins",
					viewPath: "/apps/plugins",
					viewType: "gui",
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "horizontal",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("split vertical instead") as never,
			undefined,
			{
				action: "split",
				layout: "vertical",
				views: ["notes", "plugins-page", "calendar"],
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["plugins-page", "calendar"],
			layout: "vertical",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "vertical",
				}),
			}),
		);
	});

	it("reuses current split views for text-only layout follow-ups", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({
						id: "plugins-page",
						label: "Plugins",
						path: "/apps/plugins",
					}),
					view({ id: "calendar", label: "Calendar", path: "/calendar" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "plugins-page",
					viewLabel: "Plugins",
					viewPath: "/apps/plugins",
					viewType: "gui",
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "horizontal",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("split vertical instead") as never,
			undefined,
			undefined,
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["plugins-page", "calendar"],
			layout: "vertical",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "vertical",
				}),
			}),
		);
	});

	it("reuses current split views when planner supplies a filtered view type", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const listViews = vi.fn(async (options?: { viewType?: string }) =>
			options?.viewType === "tui"
				? []
				: [
						view({
							id: "plugins-page",
							label: "Plugins",
							path: "/apps/plugins",
						}),
						view({ id: "calendar", label: "Calendar", path: "/calendar" }),
					],
		);
		const action = createViewsAction({
			client: {
				listViews,
				getCurrentView: vi.fn(async () => ({
					viewId: "plugins-page",
					viewLabel: "Plugins",
					viewPath: "/apps/plugins",
					viewType: "gui",
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "horizontal",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("split vertical instead") as never,
			undefined,
			{
				action: "split",
				layout: "vertical",
				viewType: "tui",
			},
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["plugins-page", "calendar"],
			layout: "vertical",
		});
		expect(listViews).toHaveBeenCalledWith({ viewType: "tui" });
		expect(listViews).toHaveBeenCalledWith();
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/plugins-page/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["plugins-page", "calendar"],
					layout: "vertical",
				}),
			}),
		);
	});

	it("places a single current view without retrying split failures", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const action = createViewsAction({
			client: {
				listViews: vi.fn(async () => [
					view({ id: "notes", label: "Notes", path: "/notes" }),
				]),
				getCurrentView: vi.fn(async () => ({
					viewId: "notes",
					viewLabel: "Notes",
					viewPath: "/notes",
					viewType: "gui",
				})),
			},
			hasOwnerAccess: vi.fn(async () => true),
		});

		vi.mocked(globalThis.fetch).mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ ok: true }),
		} as Response);

		const result = await action.handler(
			runtime as never,
			message("i want notes to be on left of screen") as never,
			undefined,
			{ action: "create" },
			callback,
		);

		expect(result?.success).toBe(true);
		expect(result?.values).toMatchObject({
			mode: "split",
			viewIds: ["notes"],
			layout: "horizontal",
			placement: "left",
		});
		expect(globalThis.fetch).toHaveBeenCalledWith(
			"http://127.0.0.1:3456/api/views/notes/navigate",
			expect.objectContaining({
				method: "POST",
				body: JSON.stringify({
					action: "split-view",
					views: ["notes"],
					layout: "horizontal",
					placement: "left",
				}),
			}),
		);
		expect(callback).toHaveBeenCalledWith(
			expect.objectContaining({
				text: "Placed Notes on the left.",
			}),
		);
	});

	it("treats explicit create cancel as terminal even if the pending task is gone", async () => {
		const { runtime } = createRuntime();
		const callback = vi.fn();
		const appClient = {
			listInstalledApps: vi.fn(async () => []),
		};

		const appResult = await runCreate({
			runtime: runtime as never,
			client: appClient as never,
			message: message("Cancel the app create flow") as never,
			options: { action: "create", choice: "cancel" },
			callback,
			repoRoot: "/tmp/no-app-create",
		});

		expect(appResult.success).toBe(true);
		expect(appResult.values).toMatchObject({
			mode: "create",
			subMode: "cancel",
		});
		expect(appClient.listInstalledApps).not.toHaveBeenCalled();
		expect(runtime.createTask).not.toHaveBeenCalled();

		const viewResult = await runViewsCreate({
			runtime: runtime as never,
			message: message("Cancel the view create flow") as never,
			options: { action: "create", choice: "cancel" },
			views: [view()],
			callback,
			repoRoot: "/tmp/no-view-create",
		});

		expect(viewResult.success).toBe(true);
		expect(viewResult.values).toMatchObject({
			mode: "create",
			subMode: "cancel",
		});
		expect(runtime.createTask).not.toHaveBeenCalled();
	});
});
