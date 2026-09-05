/**
 * Exercises saved APP/VIEWS choice binding through real handlers and schemas.
 * Task storage and coding dispatch are deterministic collaborators; snapshots
 * are disabled so this suite performs no git writes or coding mutations.
 */
import { fileURLToPath } from "node:url";
import type {
	HandlerOptions,
	IAgentRuntime,
	Memory,
	Task,
	UUID,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { validateToolArgs } from "../../../../packages/core/src/actions/validate-tool-args.js";
import { createAppAction } from "./app.js";
import { APP_CREATE_INTENT_TAG, runCreate } from "./app-create.js";
import { createViewsAction } from "./views.js";
import type { ViewSummary } from "./views-client.js";
import { runViewsCreate, VIEWS_CREATE_INTENT_TAG } from "./views-create.js";

vi.mock("./scaffold-env.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("./scaffold-env.js")>()),
	preflightCodingDispatch: async () => ({ ok: true }),
	resolveAppsLandingRoot: () => "/nonexistent-choice-binding-test",
}));
vi.mock("./views-snapshot.js", () => ({
	createPreEditSnapshot: vi.fn(async () => ({
		ok: false,
		reason: "Snapshots disabled in binding test",
	})),
	persistSnapshotRecord: vi.fn(),
}));

const agentId = "00000000-0000-0000-0000-000000000001" as UUID;
const roomId = "00000000-0000-0000-0000-000000000002" as UUID;
const foreignId = "00000000-0000-0000-0000-000000000003" as UUID;
const repoRoot = fileURLToPath(new URL("../../../../", import.meta.url));
type Family = "APP" | "VIEWS";

function pending(family: Family, newer = false): Task {
	return {
		id: (newer
			? "00000000-0000-0000-0000-000000000005"
			: "00000000-0000-0000-0000-000000000004") as UUID,
		agentId,
		roomId,
		entityId: agentId,
		name: `${family} pending`,
		tags: [family === "APP" ? APP_CREATE_INTENT_TAG : VIEWS_CREATE_INTENT_TAG],
		metadata: {
			roomId,
			intent: newer ? "Newer design intent" : "Older design intent",
			intentCreatedAt: newer ? "2026-09-05T10:00:00Z" : "2026-09-04T10:00:00Z",
			choices: [
				{ key: "new", label: "New" },
				{
					key: "edit-1",
					label: newer ? "Newer target" : "Older target",
					appName: newer ? "newer-app" : "older-app",
					pluginName: newer
						? "@elizaos/plugin-health"
						: "@elizaos/plugin-app-control",
				},
				{ key: "cancel", label: "Cancel" },
			],
		},
	};
}

function harness(family: Family, tasks: Task[]) {
	const dispatch = vi.fn(
		async (
			_runtime: IAgentRuntime,
			_message: Memory,
			_state: unknown,
			options?: HandlerOptions,
		) => ({
			success: true,
			data: {
				agents: [
					{
						sessionId: "coding-session",
						agentType: "claude",
						workdir: options?.parameters?.workdir ?? "/fixture",
						label: "bound edit",
						status: "running",
					},
				],
			},
		}),
	);
	const runtime = {
		agentId,
		actions: [{ name: "START_CODING_TASK", handler: dispatch }],
		// Deliberately return foreign rows too: the handler must validate scope.
		getTasks: vi.fn(async () => tasks),
		deleteTask: vi.fn(async (id: UUID) => {
			const index = tasks.findIndex((task) => task.id === id);
			if (index >= 0) tasks.splice(index, 1);
		}),
		createTask: vi.fn(),
		getSetting: vi.fn(() => undefined),
		getService: vi.fn(() => null),
		getRoom: vi.fn(async () => null),
		getEntityById: vi.fn(async () => null),
		reportError: vi.fn(),
	} as unknown as IAgentRuntime;
	const callback = vi.fn(async () => []);
	const apps = [false, true].map((newer) => ({
		name: newer ? "newer-app" : "older-app",
		displayName: newer ? "Newer target" : "Older target",
		pluginName: newer
			? "@elizaos/plugin-health"
			: "@elizaos/plugin-app-control",
		version: "1",
		installedAt: "2026-09-04T00:00:00Z",
	}));
	const listInstalledApps = vi.fn(async () => apps);
	const client = {
		listInstalledApps,
		listAppRuns: vi.fn(),
		launchApp: vi.fn(),
		stopApp: vi.fn(),
		stopAppRun: vi.fn(),
	};
	const views = apps.map((app) => ({
		id: app.name,
		label: app.displayName,
		pluginName: app.pluginName,
		viewType: "gui",
	})) as ViewSummary[];
	const run = (
		options: Record<string, unknown>,
		entityId: UUID | undefined = agentId,
	) => {
		const message = {
			agentId,
			roomId,
			entityId,
			content: {
				text: "Apply the choice to my earlier design",
				source: "client_chat",
			},
		} as Memory;
		return family === "APP"
			? runCreate({ runtime, message, options, callback, repoRoot, client })
			: runViewsCreate({
					runtime,
					message,
					options,
					callback,
					repoRoot,
					views,
				});
	};
	return { run, runtime, callback, dispatch, listInstalledApps };
}

describe.each(["APP", "VIEWS"] as const)(
	"%s pending task binding",
	(family) => {
		it("persists the originating actor and room on new pending choices", async () => {
			const h = harness(family, []);
			const result = await h.run({ intent: "older target" });
			expect(result.success).toBe(true);
			expect(h.runtime.createTask).toHaveBeenCalledOnce();
			expect(h.runtime.createTask).toHaveBeenCalledWith(
				expect.objectContaining({
					entityId: agentId,
					roomId,
					metadata: expect.objectContaining({ roomId }),
				}),
			);
			expect(h.dispatch).not.toHaveBeenCalled();
		});

		it("edits the older explicitly selected task, preserving the newer task and intent", async () => {
			const older = pending(family);
			const newer = pending(family, true);
			const tasks = [older, newer];
			const h = harness(family, tasks);
			const result = await h.run({ choice: "edit-1", taskId: older.id });
			expect(result.success).toBe(true);
			expect(h.runtime.deleteTask).toHaveBeenCalledExactlyOnceWith(older.id);
			expect(tasks).toEqual([newer]);
			expect(h.dispatch).toHaveBeenCalledOnce();
			const params = h.dispatch.mock.calls[0][3]?.parameters;
			expect(params?.task ?? params?.prompt).toContain("Older design intent");
			expect(JSON.stringify(params)).not.toContain("Newer design intent");
			expect(result.values?.workdir).toBe(
				`${repoRoot}plugins/plugin-app-control`,
			);
		});

		it("accepts taskId through the planner schema and cancels only that older task", async () => {
			const older = pending(family);
			const newer = pending(family, true);
			const tasks = [older, newer];
			const h = harness(family, tasks);
			const validated = validateToolArgs(
				family === "APP" ? createAppAction() : createViewsAction(),
				{ action: "create", choice: "cancel", taskId: older.id },
			);
			expect(validated.valid, validated.errors.join("\n")).toBe(true);
			const result = await h.run(validated.args ?? {});
			expect(result.success).toBe(true);
			expect(tasks).toEqual([newer]);
			expect(h.runtime.deleteTask).toHaveBeenCalledExactlyOnceWith(older.id);
			expect(h.dispatch).not.toHaveBeenCalled();
		});

		it("requires taskId when several pending choices could match", async () => {
			const tasks = [pending(family), pending(family, true)];
			const before = structuredClone(tasks);
			const h = harness(family, tasks);
			const result = await h.run({ choice: "cancel" });
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				turnComplete: false,
				data: {
					error: "CREATE_CHOICE_AMBIGUOUS",
					taskIds: tasks.map((task) => task.id),
				},
			});
			expect(tasks).toEqual(before);
			expect(h.runtime.deleteTask).not.toHaveBeenCalled();
			expect(h.runtime.createTask).not.toHaveBeenCalled();
			expect(h.callback).not.toHaveBeenCalled();
			expect(h.dispatch).not.toHaveBeenCalled();
		});

		it.each([
			"missing",
			"agent",
			"room",
			"tag",
			"owner",
			"completed",
			"choice",
		])(
			"rejects a stale or wrong %s without consuming any task",
			async (invalid) => {
				const selected = pending(family);
				if (invalid === "agent") selected.agentId = foreignId;
				if (invalid === "room") selected.roomId = foreignId;
				if (invalid === "tag") selected.tags = ["other-intent"];
				if (invalid === "owner") selected.entityId = foreignId;
				if (invalid === "completed") selected.status = "COMPLETED";
				const tasks = [selected, pending(family, true)];
				const before = structuredClone(tasks);
				const h = harness(family, tasks);
				const result = await h.run({
					choice: invalid === "choice" ? "edit-999" : "cancel",
					taskId: invalid === "missing" ? foreignId : selected.id,
				});
				expect(result).toMatchObject({
					success: false,
					transcriptVisibility: "internal",
					turnComplete: false,
				});
				expect(tasks).toEqual(before);
				expect(h.runtime.deleteTask).not.toHaveBeenCalled();
				expect(h.runtime.createTask).not.toHaveBeenCalled();
				expect(h.callback).not.toHaveBeenCalled();
				expect(h.dispatch).not.toHaveBeenCalled();
			},
		);

		it("denies a non-owner before reading or consuming pending tasks", async () => {
			const selected = pending(family);
			const h = harness(family, [selected]);
			const result = await h.run(
				{ choice: "cancel", taskId: selected.id },
				foreignId,
			);
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
			});
			expect(h.runtime.getTasks).not.toHaveBeenCalled();
			expect(h.runtime.deleteTask).not.toHaveBeenCalled();
			expect(h.callback).not.toHaveBeenCalled();
		});

		it("preserves the task when its saved edit target is no longer registered", async () => {
			const selected = pending(family);
			selected.metadata = {
				...selected.metadata,
				choices: [
					{
						key: "edit-1",
						label: "Removed target",
						appName: "removed-app",
						pluginName: "@missing/plugin-removed",
					},
				],
			};
			const tasks = [selected, pending(family, true)];
			const before = structuredClone(tasks);
			const h = harness(family, tasks);
			const result = await h.run({ choice: "edit-1", taskId: selected.id });
			expect(result).toMatchObject({
				success: false,
				transcriptVisibility: "internal",
				data: { error: "CREATE_CHOICE_TARGET_NOT_FOUND" },
			});
			expect(tasks).toEqual(before);
			expect(h.runtime.deleteTask).not.toHaveBeenCalled();
			expect(h.runtime.createTask).not.toHaveBeenCalled();
			expect(h.dispatch).not.toHaveBeenCalled();
			expect(h.callback).not.toHaveBeenCalled();
		});

		it.each([
			{ choice: "cancel", taskId: " " },
			{ choice: "cancel", taskId: 17 },
			{ parameters: { choice: "cancel", taskId: " " } },
			{ parameters: { choice: "cancel", taskId: 17 } },
		])(
			"rejects an invalid supplied taskId without a lookup fallback: %j",
			async (options) => {
				const selected = pending(family);
				const tasks = [selected];
				const h = harness(family, tasks);
				const result = await h.run(options);
				expect(result).toMatchObject({
					success: false,
					transcriptVisibility: "internal",
					data: { error: "CREATE_CHOICE_TASK_INVALID" },
				});
				expect(tasks).toEqual([selected]);
				expect(h.runtime.getTasks).not.toHaveBeenCalled();
				expect(h.runtime.deleteTask).not.toHaveBeenCalled();
				expect(h.runtime.createTask).not.toHaveBeenCalled();
				expect(h.callback).not.toHaveBeenCalled();
			},
		);

		it("preserves legacy metadata-room single-choice cancellation", async () => {
			const selected = pending(family);
			delete selected.roomId;
			delete selected.entityId;
			const h = harness(family, [selected]);
			const result = await h.run({ choice: "cancel" });
			expect(result.success).toBe(true);
			expect(h.runtime.deleteTask).toHaveBeenCalledExactlyOnceWith(selected.id);
		});
	},
);
