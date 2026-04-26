/**
 * @module plugin-app-control/actions/__tests__/app-action.test
 *
 * Multi-turn validate semantics for the unified APP action.
 */

import type { IAgentRuntime, Memory, Task } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { createAppAction } from "../app.js";
import { APP_CREATE_INTENT_TAG } from "../app-create.js";

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
