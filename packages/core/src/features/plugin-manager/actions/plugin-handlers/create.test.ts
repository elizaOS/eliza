/**
 * Deterministic unit tests for the plugin-manager create/edit subaction
 * handler: choice-reply detection, pending-intent lookup, cancel/stale/guard
 * branches, disambiguation persistence, real template scaffolding against a
 * temporary repo root, and delegated coding-task dispatch. Collaborators
 * (runtime service, task store, callback) are in-memory fakes; the module under
 * test and the filesystem it scaffolds into are real.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IAgentRuntime } from "../../../../types/runtime.ts";
import type { EjectedPluginInfo } from "../../types.ts";
import {
	hasPendingPluginCreateIntent,
	isPluginCreateChoiceReply,
	PLUGIN_CREATE_INTENT_TAG,
	type PluginCreateIntentMetadata,
	runCreate,
} from "./create.ts";

const AGENT_ID = "00000000-0000-4000-8000-0000000000a1";
const ROOM_A = "00000000-0000-4000-8000-00000000000a";

interface Harness {
	runtime: IAgentRuntime;
	getAllPlugins: ReturnType<typeof vi.fn>;
	listInstalledPlugins: ReturnType<typeof vi.fn>;
	listEjectedPlugins: ReturnType<typeof vi.fn>;
	getTasks: ReturnType<typeof vi.fn>;
	createTask: ReturnType<typeof vi.fn>;
	deleteTask: ReturnType<typeof vi.fn>;
	callback: ReturnType<typeof vi.fn>;
	tasks: Array<Record<string, unknown>>;
}

function buildHarness(): Harness {
	const tasks: Array<Record<string, unknown>> = [];
	const service = {
		getAllPlugins: vi.fn(() => []),
		listInstalledPlugins: vi.fn(async () => []),
		listEjectedPlugins: vi.fn(async () => [] as EjectedPluginInfo[]),
	};
	const getTasks = vi.fn(async () => tasks);
	const createTask = vi.fn(async (task: Record<string, unknown>) => {
		tasks.push({ ...task, id: `task-${tasks.length + 1}` });
	});
	const deleteTask = vi.fn(async () => undefined);
	const callback = vi.fn(async () => []);
	const runtime = {
		agentId: AGENT_ID,
		actions: [],
		getService: vi.fn((name: string) =>
			name === "plugin_manager" ? service : null,
		),
		getTasks,
		createTask,
		deleteTask,
	} as unknown as IAgentRuntime;
	return {
		runtime,
		getAllPlugins: service.getAllPlugins,
		listInstalledPlugins: service.listInstalledPlugins,
		listEjectedPlugins: service.listEjectedPlugins,
		getTasks,
		createTask,
		deleteTask,
		callback,
		tasks,
	};
}

function makeMessage(text: string): Parameters<typeof runCreate>[0]["message"] {
	return {
		entityId: AGENT_ID,
		agentId: AGENT_ID,
		roomId: ROOM_A,
		content: { text },
	};
}

function makePendingIntent(
	overrides?: Partial<PluginCreateIntentMetadata> & { id?: string },
): Record<string, unknown> {
	const metadata: PluginCreateIntentMetadata = {
		roomId: ROOM_A,
		intent: "build a weather plugin",
		choices: [
			{ key: "new", label: "Create new plugin" },
			{
				key: "edit-1",
				label: "Edit existing: plugin-weather",
				pluginName: "plugin-weather",
				pluginPath: "/repo/plugins/plugin-weather",
			},
			{ key: "cancel", label: "Cancel" },
		],
		intentCreatedAt: new Date("2026-08-24T00:00:00.000Z").toISOString(),
		...overrides,
	};
	return {
		id: overrides?.id ?? "intent-task-1",
		name: "PLUGIN_CREATE intent",
		tags: [PLUGIN_CREATE_INTENT_TAG],
		metadata,
	};
}

const WEATHER_PLUGIN: EjectedPluginInfo = {
	name: "plugin-weather",
	path: "/repo/plugins/plugin-weather",
	version: "0.1.0",
	upstream: null,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("isPluginCreateChoiceReply", () => {
	it("accepts canonical new / edit-N / cancel replies", () => {
		expect(isPluginCreateChoiceReply("new")).toBe(true);
		expect(isPluginCreateChoiceReply("edit-1")).toBe(true);
		expect(isPluginCreateChoiceReply("edit-12")).toBe(true);
		expect(isPluginCreateChoiceReply("cancel")).toBe(true);
	});

	it("is case-insensitive and trims surrounding whitespace", () => {
		expect(isPluginCreateChoiceReply("  NEW ")).toBe(true);
		expect(isPluginCreateChoiceReply("Cancel")).toBe(true);
		expect(isPluginCreateChoiceReply("\tEdit-3\n")).toBe(true);
	});

	it("rejects non-choice strings without mutating them", () => {
		for (const candidate of [
			"",
			"newer",
			"new-plugin",
			"edit-",
			"edit-x",
			"delete",
			"yes",
		]) {
			expect(isPluginCreateChoiceReply(candidate)).toBe(false);
		}
	});
});

describe("hasPendingPluginCreateIntent", () => {
	it("queries tagged tasks for this agent and finds a room-matching intent", async () => {
		const harness = buildHarness();
		harness.tasks.push(makePendingIntent());
		await expect(
			hasPendingPluginCreateIntent(harness.runtime, ROOM_A),
		).resolves.toBe(true);
		expect(harness.getTasks).toHaveBeenCalledWith({
			agentIds: [AGENT_ID],
			tags: [PLUGIN_CREATE_INTENT_TAG],
		});
	});

	it("returns false when no intent tasks exist", async () => {
		const harness = buildHarness();
		await expect(
			hasPendingPluginCreateIntent(harness.runtime, ROOM_A),
		).resolves.toBe(false);
	});

	it("returns false when the latest intent belongs to another room", async () => {
		const harness = buildHarness();
		harness.tasks.push(
			makePendingIntent({
				roomId: "00000000-0000-4000-8000-00000000000b",
				id: "intent-task-other-room",
			}),
		);
		await expect(
			hasPendingPluginCreateIntent(harness.runtime, ROOM_A),
		).resolves.toBe(false);
	});
});

describe("runCreate cancel path", () => {
	it("deletes the pending intent, notifies once via callback, and awaits it", async () => {
		const harness = buildHarness();
		const pending = makePendingIntent();
		harness.tasks.push(pending);

		let callbackSettled = false;
		harness.callback.mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 5));
			callbackSettled = true;
			return [];
		});

		const result = await runCreate({
			runtime: harness.runtime,
			message: makeMessage("whatever the raw message says"),
			choice: "cancel",
			repoRoot: "/unused",
			callback: harness.callback,
		});

		expect(result).toEqual({
			success: true,
			text: "Canceled. No plugin changes made.",
			values: { mode: "create", subMode: "cancel" },
		});
		expect(harness.deleteTask).toHaveBeenCalledTimes(1);
		expect(harness.deleteTask).toHaveBeenCalledWith("intent-task-1");
		expect(harness.callback).toHaveBeenCalledTimes(1);
		expect(harness.callback).toHaveBeenCalledWith({
			text: "Canceled. No plugin changes made.",
		});
		expect(callbackSettled).toBe(true);
		expect(harness.createTask).not.toHaveBeenCalled();
	});
});

describe("runCreate guard rails", () => {
	it("fails with a planner-facing ask when no intent is available anywhere", async () => {
		const harness = buildHarness();
		const result = await runCreate({
			runtime: harness.runtime,
			message: makeMessage("   "),
			repoRoot: "/unused",
		});

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			"No plugin intent found in the request; ask the user what plugin they want to build.",
		);
		expect(harness.callback).not.toHaveBeenCalled();
		expect(harness.createTask).not.toHaveBeenCalled();
	});

	it("rejects an explicit editTarget that matches no known local plugin", async () => {
		const harness = buildHarness();
		harness.listEjectedPlugins.mockResolvedValue([WEATHER_PLUGIN]);

		const result = await runCreate({
			runtime: harness.runtime,
			message: makeMessage("make it better"),
			editTarget: "plugin-nope",
			intent: "make it better",
			repoRoot: "/unused",
		});

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			'Cannot find a local plugin named "plugin-nope"; tell the user no such plugin exists locally.',
		);
		expect(harness.getAllPlugins).toHaveBeenCalled();
		expect(harness.listEjectedPlugins).toHaveBeenCalled();
		expect(harness.createTask).not.toHaveBeenCalled();
	});

	it("reports a stale edit option and still consumes the intent task", async () => {
		const harness = buildHarness();
		harness.tasks.push(makePendingIntent());
		const result = await runCreate({
			runtime: harness.runtime,
			message: makeMessage("edit-1"),
			repoRoot: "/unused",
		});

		expect(result.success).toBe(false);
		expect(result.text).toBe(
			'Plugin edit target "edit-1" is no longer available; tell the user that option has gone stale.',
		);
		expect(harness.deleteTask).toHaveBeenCalledWith("intent-task-1");
		expect(harness.callback).not.toHaveBeenCalled();
	});
});

describe("runCreate disambiguation", () => {
	it("persists the intent and emits a choice block when the intent matches an ejected plugin", async () => {
		const harness = buildHarness();
		harness.listEjectedPlugins.mockResolvedValue([WEATHER_PLUGIN]);

		const result = await runCreate({
			runtime: harness.runtime,
			message: makeMessage(""),
			options: { parameters: { intent: "please update the weather plugin" } },
			repoRoot: "/unused",
			callback: harness.callback,
		});

		expect(result.success).toBe(true);
		expect(result.text).toBe(
			"Asked the user to pick: create a new plugin, edit an existing match, or cancel.",
		);
		expect(result.userFacingText).toContain("[CHOICE:plugin-create id=");
		expect(result.userFacingText).toContain("new = Create new plugin");
		expect(result.userFacingText).toContain(
			"edit-1 = Edit existing: plugin-weather",
		);
		expect(result.userFacingText).toContain("cancel = Cancel");
		expect(result.userFacingText?.endsWith("[/CHOICE]")).toBe(true);
		expect(result.verifiedUserFacing).toBe(true);
		expect(result.turnComplete).toBe(true);
		expect(result.values).toEqual({
			mode: "create",
			subMode: "choice",
			matchCount: 1,
		});
		expect(result.data?.choices).toHaveLength(3);
		expect(result.data?.choices.map((choice) => choice.key)).toEqual([
			"new",
			"edit-1",
			"cancel",
		]);
		expect(result.data?.choices[1].pluginName).toBe("plugin-weather");

		expect(harness.createTask).toHaveBeenCalledTimes(1);
		const persisted = harness.createTask.mock.calls[0][0];
		expect(persisted.tags).toEqual([PLUGIN_CREATE_INTENT_TAG]);
		expect(persisted.metadata.roomId).toBe(ROOM_A);
		expect(persisted.metadata.intent).toBe("please update the weather plugin");
		expect(persisted.metadata.intentCreatedAt).toEqual(expect.any(String));

		expect(harness.callback).toHaveBeenCalledTimes(1);
		expect(harness.callback).toHaveBeenCalledWith({
			text: result.userFacingText,
		});
	});
});

describe("runCreate scaffold new plugin", () => {
	let repoRoot = "";

	afterEach(async () => {
		if (repoRoot) {
			await fs.rm(repoRoot, { recursive: true, force: true });
			repoRoot = "";
		}
	});

	it("copies the min-plugin template with substitutions, then fails gracefully when no coding action can be dispatched", async () => {
		repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "plugin-create-"));
		const templateDir = path.join(
			repoRoot,
			"packages/elizaos/templates/min-plugin",
		);
		await fs.mkdir(path.join(templateDir, "src"), { recursive: true });
		await fs.writeFile(
			path.join(templateDir, "package.json"),
			JSON.stringify({
				name: "__PLUGIN_NAME__",
				displayName: "__PLUGIN_DISPLAY_NAME__",
			}),
		);
		await fs.writeFile(
			path.join(templateDir, "src/index.ts"),
			"// __PLUGIN_DISPLAY_NAME__ (__PLUGIN_NAME__)\nexport default 1;\n",
		);
		await fs.mkdir(path.join(repoRoot, "plugins"), { recursive: true });

		const harness = buildHarness();
		const result = await runCreate({
			runtime: harness.runtime,
			message: makeMessage("build a crypto price tracker plugin"),
			repoRoot,
		});

		const expectedWorkdir = path.join(
			repoRoot,
			"plugins/plugin-crypto-price-tracker",
		);
		expect(result.success).toBe(false);
		expect(result.text).toBe(
			`Scaffolded Crypto Price Tracker at ${expectedWorkdir}, but could not dispatch a coding agent: Coding delegation action not registered.`,
		);
		expect(result.values).toEqual({
			mode: "create",
			workdir: expectedWorkdir,
		});
		expect(harness.callback).not.toHaveBeenCalled();

		const scaffoldedPackageJson = JSON.parse(
			await fs.readFile(path.join(expectedWorkdir, "package.json"), "utf8"),
		) as { name: string; displayName: string };
		expect(scaffoldedPackageJson.name).toBe(
			"@elizaos/plugin-crypto-price-tracker",
		);
		expect(scaffoldedPackageJson.displayName).toBe("Crypto Price Tracker");

		const scaffoldedIndex = await fs.readFile(
			path.join(expectedWorkdir, "src/index.ts"),
			"utf8",
		);
		expect(scaffoldedIndex).toContain(
			"Crypto Price Tracker (@elizaos/plugin-crypto-price-tracker)",
		);
		expect(scaffoldedIndex).not.toContain("__PLUGIN_NAME__");

		const templatePackageJson = await fs.readFile(
			path.join(templateDir, "package.json"),
			"utf8",
		);
		expect(templatePackageJson).toContain("__PLUGIN_NAME__");
	});
});

describe("runCreate delegated edit dispatch", () => {
	it("resolves edit-N from the pending intent, dispatches the coding action, and reports the started task", async () => {
		const harness = buildHarness();
		harness.tasks.push(makePendingIntent());
		harness.listEjectedPlugins.mockResolvedValue([WEATHER_PLUGIN]);
		const codingHandler = vi.fn(async () => ({
			success: true,
			text: "started",
			data: {
				agents: [
					{
						sessionId: "sess-1",
						agentType: "claude-code",
						workdir: WEATHER_PLUGIN.path,
						label: "edit-plugin:plugin-weather",
						status: "running",
					},
				],
			},
		}));
		const codingAction = {
			name: "START_CODING_TASK",
			description: "delegate a coding task",
			similes: [] as string[],
			examples: [] as unknown[],
			handler: codingHandler,
			validate: async () => true,
		};
		(harness.runtime as { actions: unknown[] }).actions = [codingAction];

		const result = await runCreate({
			runtime: harness.runtime,
			message: makeMessage("edit-1"),
			repoRoot: "/unused",
		});

		expect(harness.deleteTask).toHaveBeenCalledWith("intent-task-1");
		expect(codingHandler).toHaveBeenCalledTimes(1);
		const handlerOptions = codingHandler.mock.calls[0][3] as {
			parameters: {
				task: string;
				validator: { params: { workdir: string; pluginName: string } };
			};
		};
		expect(handlerOptions.parameters.task).toContain(
			'You are modifying the existing Eliza plugin "plugin-weather".',
		);
		expect(handlerOptions.parameters.validator.params.pluginName).toBe(
			"plugin-weather",
		);
		expect(handlerOptions.parameters.validator.params.workdir).toBe(
			WEATHER_PLUGIN.path,
		);

		expect(result.success).toBe(true);
		expect(result.text).toBe(
			`Started plugin edit task for plugin-weather at ${WEATHER_PLUGIN.path}. Task session sess-1 is running; verification will run when it emits PLUGIN_CREATE_DONE.`,
		);
		expect(result.values).toEqual({
			mode: "create",
			subMode: "edit",
			name: "plugin-weather",
			workdir: WEATHER_PLUGIN.path,
			taskStatus: "running",
			taskSessionId: "sess-1",
		});
		expect(result.data?.agents).toHaveLength(1);
	});
});
