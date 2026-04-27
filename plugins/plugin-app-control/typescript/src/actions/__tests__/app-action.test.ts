/**
 * @module plugin-app-control/actions/__tests__/app-action.test
 *
 * Multi-turn validate semantics for the unified APP action.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
	ActionResult,
	HandlerOptions,
	IAgentRuntime,
	Memory,
	Task,
} from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import type { AppControlClient } from "../../client/api.js";
import { createAppAction } from "../app.js";
import { APP_CREATE_INTENT_TAG, runCreate } from "../app-create.js";

interface FakeRuntimeOptions {
	tasks?: Task[];
	allow?: boolean;
}

function makeRuntime(opts: FakeRuntimeOptions = {}): IAgentRuntime {
	const tasks = opts.tasks ?? [];
	return {
		agentId: "agent-1",
		actions: [],
		getTasks: vi.fn(async () => tasks),
		createTask: vi.fn(async () => "task-id"),
		deleteTask: vi.fn(async () => {}),
	} as unknown as IAgentRuntime;
}

function makeMessage(text: string, roomId = "room-1"): Memory {
	return {
		roomId,
		entityId: "entity-1",
		content: { text },
	} as unknown as Memory;
}

function intentTask(roomId: string): Task {
	return {
		id: "task-existing",
		name: "APP_CREATE intent",
		tags: [APP_CREATE_INTENT_TAG],
		metadata: {
			roomId,
			intent: "build me a notes app",
			choices: [
				{ key: "new", label: "Create a new app" },
				{ key: "edit-1", label: "Edit Notes", appName: "@me/app-notes" },
				{ key: "cancel", label: "Cancel" },
			],
			createdAt: Date.now(),
			isCompleted: false,
		},
	} as unknown as Task;
}

describe("APP action validate (multi-turn)", () => {
	it("returns true on first-turn create intent", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({});
		const result = await action.validate(
			runtime,
			makeMessage("create a new note-taking app for me"),
		);
		expect(result).toBe(true);
	});

	it("returns true on first-turn launch intent", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({});
		const result = await action.validate(
			runtime,
			makeMessage("launch the shopify app"),
		);
		expect(result).toBe(true);
	});

	it("returns true on follow-up choice reply when an intent task exists", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({ tasks: [intentTask("room-1")] });
		const result = await action.validate(runtime, makeMessage("new", "room-1"));
		expect(result).toBe(true);
	});

	it("returns true on edit-N reply when an intent task exists", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({ tasks: [intentTask("room-1")] });
		const result = await action.validate(
			runtime,
			makeMessage("edit-1", "room-1"),
		);
		expect(result).toBe(true);
	});

	it("returns true on cancel reply when an intent task exists", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({ tasks: [intentTask("room-1")] });
		const result = await action.validate(
			runtime,
			makeMessage("cancel", "room-1"),
		);
		expect(result).toBe(true);
	});

	it("returns false on choice-shaped reply when no intent task exists", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({ tasks: [] });
		const result = await action.validate(runtime, makeMessage("new", "room-1"));
		expect(result).toBe(false);
	});

	it("returns false on unrelated chatter", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({ tasks: [] });
		const result = await action.validate(
			runtime,
			makeMessage("good morning, how is the weather?"),
		);
		expect(result).toBe(false);
	});

	it("returns false when owner access is denied", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => false,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({});
		const result = await action.validate(
			runtime,
			makeMessage("create a new note-taking app"),
		);
		expect(result).toBe(false);
	});

	it("ignores intent tasks for other rooms", async () => {
		const action = createAppAction({
			hasOwnerAccess: async () => true,
			repoRoot: "/tmp/repo",
		});
		const runtime = makeRuntime({ tasks: [intentTask("room-1")] });
		const result = await action.validate(runtime, makeMessage("new", "room-2"));
		expect(result).toBe(false);
	});

	it("registers all legacy single-purpose action names as similes", () => {
		const action = createAppAction({});
		expect(action.similes).toContain("LAUNCH_APP");
		expect(action.similes).toContain("CLOSE_APP");
		expect(action.similes).toContain("LIST_RUNNING_APPS");
	});
});

describe("APP create dispatch", () => {
	it("passes verifier policy through CREATE_TASK parameters with canonical completion proof", async () => {
		const repoRoot = await mkdtemp(path.join(tmpdir(), "milady-app-create-"));
		try {
			const templateDir = path.join(repoRoot, "eliza/templates/min-app");
			await mkdir(templateDir, { recursive: true });
			await writeFile(
				path.join(templateDir, "package.json"),
				'{"name":"__APP_NAME__","displayName":"__APP_DISPLAY_NAME__"}\n',
				"utf8",
			);

			const createTaskResult: ActionResult = {
				success: true,
				text: "",
				data: {
					agents: [
						{
							sessionId: "session-app-1",
							agentType: "codex",
							workdir: "/tmp/task-workdir",
							label: "create-app:note-taker",
							status: "running",
						},
					],
				},
			};
			const createTaskHandler = vi.fn(async () => createTaskResult);
			const runtime = {
				agentId: "agent-1",
				actions: [{ name: "CREATE_TASK", handler: createTaskHandler }],
				getTasks: vi.fn(async () => []),
				createTask: vi.fn(async () => "task-id"),
				deleteTask: vi.fn(async () => {}),
				useModel: vi.fn(
					async () => "name: note-taker\ndisplayName: Note Taker",
				),
			} as unknown as IAgentRuntime;
			const client = {
				listInstalledApps: vi.fn(async () => []),
			} as unknown as AppControlClient;
			const callback = vi.fn(async () => []);

			const result = await runCreate({
				runtime,
				client,
				message: makeMessage("build me a note taking app"),
				callback,
				repoRoot,
			});

			expect(result.success).toBe(true);
			expect(result.text).toContain("Task session session-app-1 is running");
			expect(createTaskHandler).toHaveBeenCalledTimes(1);

			const handlerOptions = (createTaskHandler.mock.calls[0] as unknown[])[
				3
			] as HandlerOptions;
			const parameters = handlerOptions.parameters as Record<string, unknown>;
			expect(parameters.task).toContain(
				'APP_CREATE_DONE {"appName":"note-taker"',
			);
			expect(parameters.task).toContain("bun run typecheck");
			expect(parameters.task).toContain("bun run lint");
			expect(parameters.task).toContain("bun run test");
			expect(parameters).toMatchObject({
				label: "create-app:note-taker",
				approvalPreset: "permissive",
				onVerificationFail: "retry",
			});
			expect(parameters.agentType).toBeUndefined();
			expect(parameters.env).toBeUndefined();
			expect((handlerOptions as Record<string, unknown>).validator).toBeUndefined();
			expect((handlerOptions as Record<string, unknown>).env).toBeUndefined();
			expect(JSON.stringify(handlerOptions)).not.toContain("ANTHROPIC_MODEL");

			const validator = parameters.validator as Record<string, unknown>;
			expect(validator).toMatchObject({
				service: "app-verification",
				method: "verifyApp",
				params: {
					appName: "note-taker",
					profile: "full",
				},
			});
		} finally {
			await rm(repoRoot, { recursive: true, force: true });
		}
	});
});
