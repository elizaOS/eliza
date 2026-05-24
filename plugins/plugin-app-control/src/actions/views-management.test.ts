import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createViewsAction } from "./views.js";
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

vi.mock("@elizaos/core", () => coreMock);

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

	it("requires confirmation before deleting a view and unloads the plugin after yes", async () => {
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

			vi.mocked(globalThis.fetch).mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ message: "Plugin stopped" }),
			} as Response);

			const second = await runViewsDelete({
				runtime: runtime as never,
				message: message("yes") as never,
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
				"http://127.0.0.1:3456/api/apps/stop",
				expect.objectContaining({
					method: "POST",
					body: JSON.stringify({ name: "@local/plugin-ledger" }),
				}),
			);
			expect(second.text).toContain("Plugin stopped");
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
				json: async () => ({ message: "Plugin stopped" }),
			} as Response);

			const deleteResult = await action.handler(
				runtime as never,
				message("delete the remote ledger view") as never,
				undefined,
				{
					action: "delete",
					confirm: "true",
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
				"http://127.0.0.1:3456/api/apps/stop",
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
});
