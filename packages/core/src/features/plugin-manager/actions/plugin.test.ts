/**
 * Unit coverage for the MANAGE_PLUGINS umbrella action in plugin.ts: owner
 * gating and refusal shape, structured subaction routing (legacy `mode`
 * alias, normalization aliases, nested parameters), machine-parsed name and
 * query seeding into dispatch params, create choice-reply interception, and
 * resolver-driven dispatch with its clarify fallback. The sub-handler modules
 * are mocked collaborators; every assertion targets plugin.ts's own gating,
 * normalization, seeding, and dispatch decisions through a real runtime.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createMockRuntime } from "../../../testing/mock-runtime.ts";
import type { ActionResult } from "../../../types/components.ts";
import type { Memory } from "../../../types/memory.ts";
import type { IAgentRuntime } from "../../../types/runtime.ts";
import {
	createPluginAction,
	extractNameFromText,
	extractQueryFromText,
	pluginAction,
} from "./plugin.ts";
import { runCoreStatus } from "./plugin-handlers/core-status.ts";
import {
	hasPendingPluginCreateIntent,
	isPluginCreateChoiceReply,
	runCreate,
} from "./plugin-handlers/create.ts";
import { runEject } from "./plugin-handlers/eject.ts";
import { runInstall } from "./plugin-handlers/install.ts";
import { runList } from "./plugin-handlers/list.ts";
import { runListEjected } from "./plugin-handlers/list-ejected.ts";
import { runReinject } from "./plugin-handlers/reinject.ts";
import {
	runDisablePlugin,
	runEnablePlugin,
	runPluginDetails,
	runPluginStatus,
} from "./plugin-handlers/runtime-state.ts";
import { runSearch } from "./plugin-handlers/search.ts";
import { runSync } from "./plugin-handlers/sync.ts";

vi.mock("./plugin-handlers/install.ts", () => ({ runInstall: vi.fn() }));
vi.mock("./plugin-handlers/eject.ts", () => ({ runEject: vi.fn() }));
vi.mock("./plugin-handlers/sync.ts", () => ({ runSync: vi.fn() }));
vi.mock("./plugin-handlers/reinject.ts", () => ({ runReinject: vi.fn() }));
vi.mock("./plugin-handlers/list.ts", () => ({ runList: vi.fn() }));
vi.mock("./plugin-handlers/list-ejected.ts", () => ({
	runListEjected: vi.fn(),
}));
vi.mock("./plugin-handlers/search.ts", () => ({ runSearch: vi.fn() }));
vi.mock("./plugin-handlers/core-status.ts", () => ({ runCoreStatus: vi.fn() }));
vi.mock("./plugin-handlers/runtime-state.ts", () => ({
	runPluginDetails: vi.fn(),
	runPluginStatus: vi.fn(),
	runEnablePlugin: vi.fn(),
	runDisablePlugin: vi.fn(),
}));
vi.mock("./plugin-handlers/create.ts", () => ({
	runCreate: vi.fn(),
	isPluginCreateChoiceReply: vi.fn(() => false),
	hasPendingPluginCreateIntent: vi.fn(async () => false),
}));

const AGENT_ID = "00000000-0000-4000-8000-00000000a001";
const ENTITY_ID = "00000000-0000-4000-8000-00000000c001";
const ROOM_ID = "00000000-0000-4000-8000-00000000d001";

/** Valid extractor output choosing `list` (no required params). */
const MODEL_LIST_JSON =
	'{"action":"list","params":{},"missing":[],"confidence":0.9}';
/** Valid extractor output choosing `search` with no params of its own. */
const MODEL_SEARCH_JSON =
	'{"action":"search","params":{},"missing":[],"confidence":0.9}';

function message(text: string): Memory {
	return {
		entityId: ENTITY_ID,
		roomId: ROOM_ID,
		content: { text },
	} as Memory;
}

function okResult(text: string): ActionResult {
	return { success: true, text };
}

function makeRuntime(modelOutput: string = MODEL_LIST_JSON): IAgentRuntime {
	return createMockRuntime({
		useModel: vi.fn(async () => modelOutput),
	});
}

function makeCallback() {
	return vi.fn(async () => [] as Memory[]);
}

function makeAction(ownerHasAccess = true) {
	return createPluginAction({
		hasOwnerAccess: async () => ownerHasAccess,
		repoRoot: "/repo",
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(runInstall).mockResolvedValue(okResult("installed"));
	vi.mocked(runEject).mockResolvedValue(okResult("ejected"));
	vi.mocked(runSync).mockResolvedValue(okResult("synced"));
	vi.mocked(runReinject).mockResolvedValue(okResult("reinjected"));
	vi.mocked(runList).mockResolvedValue(okResult("listed"));
	vi.mocked(runListEjected).mockResolvedValue(okResult("listed ejected"));
	vi.mocked(runSearch).mockResolvedValue(okResult("searched"));
	vi.mocked(runPluginDetails).mockResolvedValue(okResult("details"));
	vi.mocked(runPluginStatus).mockResolvedValue(okResult("status"));
	vi.mocked(runEnablePlugin).mockResolvedValue(okResult("enabled"));
	vi.mocked(runDisablePlugin).mockResolvedValue(okResult("disabled"));
	vi.mocked(runCoreStatus).mockResolvedValue(okResult("core status"));
	vi.mocked(runCreate).mockResolvedValue(okResult("created"));
	vi.mocked(isPluginCreateChoiceReply).mockReturnValue(false);
	vi.mocked(hasPendingPluginCreateIntent).mockResolvedValue(false);
});

describe("extractNameFromText", () => {
	it("prefers a scoped @scope/plugin identifier", () => {
		expect(extractNameFromText("install @elizaos/plugin-pdf")).toBe(
			"@elizaos/plugin-pdf",
		);
	});

	it("extracts a bare plugin-* token before verb matching", () => {
		expect(extractNameFromText("please load plugin-sql now")).toBe(
			"plugin-sql",
		);
	});

	it("prefixes a bare capability word after an operation verb", () => {
		expect(extractNameFromText("install discord")).toBe("plugin-discord");
	});

	it("supports multi-word operation verbs like turn on", () => {
		expect(extractNameFromText("turn on music")).toBe("plugin-music");
	});

	it("keeps trailing punctuation out of the extracted name", () => {
		expect(extractNameFromText("install discord?")).toBe("plugin-discord");
	});

	it("rejects generic candidates such as core or the literal plugin", () => {
		expect(extractNameFromText("enable core")).toBeUndefined();
		expect(extractNameFromText("install the plugin")).toBeUndefined();
	});

	it("returns undefined for non-plugin text", () => {
		expect(extractNameFromText("what time is it")).toBeUndefined();
	});
});

describe("extractQueryFromText", () => {
	it("extracts the capability from search-for-plugins phrasing", () => {
		expect(
			extractQueryFromText("search for plugins that can trade crypto"),
		).toBe("trade crypto");
	});

	it("extracts the capability from find-plugins-for phrasing", () => {
		expect(extractQueryFromText("find plugins for pdf processing")).toBe(
			"pdf processing",
		);
	});

	it("extracts the capability from a short plugins-for phrasing", () => {
		expect(extractQueryFromText("plugins for chat moderation")).toBe(
			"chat moderation",
		);
	});

	it("drops captures that are too short to be a query", () => {
		expect(extractQueryFromText("search for plugins ab")).toBeUndefined();
	});

	it("returns undefined when no query phrasing matches", () => {
		expect(extractQueryFromText("tell me a joke")).toBeUndefined();
	});
});

describe("MANAGE_PLUGINS action contract", () => {
	it("registers as an owner-gated plugin-management action", () => {
		expect(pluginAction.name).toBe("MANAGE_PLUGINS");
		expect(pluginAction.roleGate).toEqual({ minRole: "OWNER" });
		expect(pluginAction.suppressPostActionContinuation).toBe(true);
	});

	it("declares a required action parameter enumerating the subactions", () => {
		const parameters = pluginAction.parameters ?? [];
		const names = parameters.map((parameter) => parameter.name);
		expect(names).toContain("action");
		expect(names).toContain("mode");
		expect(names).toContain("name");
		expect(names).toContain("query");

		const actionParam = parameters.find(
			(parameter) => parameter.name === "action",
		);
		expect(actionParam?.required).toBe(true);
		expect(actionParam?.schema?.enum).toContain("install");
		expect(actionParam?.schema?.enum).toContain("create");
		expect(actionParam?.schema?.enum).not.toContain("loaded");
	});
});

describe("handler authorization", () => {
	it("refuses a non-owner without dispatching any subaction", async () => {
		const runtime = makeRuntime();
		const callback = makeCallback();
		const action = makeAction(false);

		const result = await action.handler?.(
			runtime,
			message("list plugins"),
			undefined,
			{},
			callback,
		);

		expect(result).toMatchObject({
			success: true,
			userFacingText: "Sorry — plugin management is owner-only.",
			verifiedUserFacing: true,
			turnComplete: true,
			values: { permissionDenied: true },
		});
		const delivered = callback.mock.calls[0]?.[0];
		expect(delivered?.text).toBe("Sorry — plugin management is owner-only.");
		expect(callback).toHaveBeenCalledTimes(1);
		expect(runInstall).not.toHaveBeenCalled();
		expect(runList).not.toHaveBeenCalled();
	});

	it("requires agent and entity context even when the owner check passes", async () => {
		const runtime = createMockRuntime({
			agentId: "",
			useModel: vi.fn(async () => MODEL_LIST_JSON),
		});
		const action = makeAction(true);

		const result = await action.handler?.(
			runtime,
			message("list plugins"),
			undefined,
			{ action: "list" },
			makeCallback(),
		);

		expect(result?.values).toEqual({ permissionDenied: true });
		expect(runList).not.toHaveBeenCalled();
	});
});

describe("structured subaction routing", () => {
	it("routes an explicit install with normalized name and install options", async () => {
		const runtime = makeRuntime();
		const callback = makeCallback();
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("whatever"),
			undefined,
			{
				action: "install",
				name: "discord",
				source: "git",
				url: "https://github.com/elizaos/plugin-discord",
				version: "^1.0.0",
			},
			callback,
		);

		expect(vi.mocked(runInstall)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runInstall).mock.calls[0]?.[0]).toEqual({
			runtime,
			name: "plugin-discord",
			source: "git",
			callback,
		});
	});

	it("honors the legacy mode alias with normalization aliases", async () => {
		const runtime = makeRuntime();
		const listCallback = makeCallback();
		const disableCallback = makeCallback();
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("show loaded"),
			undefined,
			{ mode: "loaded" },
			listCallback,
		);

		await action.handler?.(
			runtime,
			message("turn it off"),
			undefined,
			{ action: "OFF" },
			disableCallback,
		);

		expect(vi.mocked(runList)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runList).mock.calls[0]?.[0]).toEqual({
			runtime,
			callback: listCallback,
		});
		expect(vi.mocked(runDisablePlugin)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runDisablePlugin).mock.calls[0]?.[0]).toEqual({
			runtime,
			name: "",
			callback: disableCallback,
		});
	});

	it("reads the subaction and name from nested parameters", async () => {
		const runtime = makeRuntime();
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("eject it"),
			undefined,
			{ parameters: { action: "eject", name: "plugin-pdf" } },
			makeCallback(),
		);

		expect(vi.mocked(runEject)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runEject).mock.calls[0]?.[0]).toMatchObject({
			runtime,
			name: "plugin-pdf",
		});
	});

	it("seeds the search query from free-form text extraction", async () => {
		const runtime = makeRuntime();
		const callback = makeCallback();
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("search for plugins that can trade crypto"),
			undefined,
			{ action: "search" },
			callback,
		);

		expect(vi.mocked(runSearch)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runSearch).mock.calls[0]?.[0]).toEqual({
			runtime,
			query: "trade crypto",
			callback,
		});
	});

	it("falls back to the raw message text when nothing is extractable", async () => {
		const runtime = makeRuntime();
		const callback = makeCallback();
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("blah"),
			undefined,
			{ action: "search" },
			callback,
		);

		expect(vi.mocked(runSearch).mock.calls[0]?.[0]).toEqual({
			runtime,
			query: "blah",
			callback,
		});
	});

	it("degrades an unknown action value to natural-language resolution", async () => {
		const runtime = makeRuntime(MODEL_LIST_JSON);
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("just do it"),
			undefined,
			{ action: "warp" },
			makeCallback(),
		);

		expect(vi.mocked(runList)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runInstall)).not.toHaveBeenCalled();
	});
});

describe("natural-language resolution", () => {
	it("dispatches the model-chosen subaction with seeded params merged in", async () => {
		const runtime = makeRuntime(MODEL_SEARCH_JSON);
		const callback = makeCallback();
		const action = makeAction();

		const result = await action.handler?.(
			runtime,
			message("search for plugins that can trade crypto"),
			undefined,
			{},
			callback,
		);

		expect(result).toEqual(okResult("searched"));
		expect(vi.mocked(runSearch)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runSearch).mock.calls[0]?.[0]).toEqual({
			runtime,
			query: "trade crypto",
			callback,
		});
	});

	it("returns the clarify failure when the resolver cannot resolve", async () => {
		const runtime = makeRuntime("I cannot help with that.");
		const callback = makeCallback();
		const action = makeAction();

		const result = await action.handler?.(
			runtime,
			message("do something vague"),
			undefined,
			{},
			callback,
		);

		expect(result).toMatchObject({
			success: false,
			data: { action: "clarify", missing: ["subaction"] },
		});
		expect(result?.text).toContain("No clear plugin operation");
		expect(runList).not.toHaveBeenCalled();
		expect(runSearch).not.toHaveBeenCalled();
	});
});

describe("create choice-reply interception", () => {
	it("routes a choice reply to runCreate while an intent is pending", async () => {
		vi.mocked(isPluginCreateChoiceReply).mockReturnValue(true);
		vi.mocked(hasPendingPluginCreateIntent).mockResolvedValue(true);
		const runtime = makeRuntime();
		const msg = message("new");
		const options = {};
		const callback = makeCallback();
		const action = makeAction();

		const result = await action.handler?.(
			runtime,
			msg,
			undefined,
			options,
			callback,
		);

		expect(result).toEqual(okResult("created"));
		expect(vi.mocked(runCreate)).toHaveBeenCalledTimes(1);
		expect(vi.mocked(runCreate).mock.calls[0]?.[0]).toEqual({
			runtime,
			message: msg,
			options,
			callback,
			choice: "new",
			repoRoot: "/repo",
		});
		expect(vi.mocked(hasPendingPluginCreateIntent)).toHaveBeenCalledWith(
			runtime,
			ROOM_ID,
		);
	});

	it("falls back to the agent id when the message carries no room", async () => {
		vi.mocked(isPluginCreateChoiceReply).mockReturnValue(true);
		vi.mocked(hasPendingPluginCreateIntent).mockResolvedValue(false);
		const runtime = createMockRuntime({
			agentId: AGENT_ID,
			useModel: vi.fn(async () => MODEL_LIST_JSON),
		});
		const action = makeAction();
		const roomless = {
			entityId: ENTITY_ID,
			content: { text: "new" },
		} as Memory;

		await action.validate(runtime, roomless, undefined, {});

		expect(vi.mocked(hasPendingPluginCreateIntent)).toHaveBeenCalledWith(
			runtime,
			AGENT_ID,
		);
	});

	it("ignores a choice reply once no intent is pending anymore", async () => {
		vi.mocked(isPluginCreateChoiceReply).mockReturnValue(true);
		vi.mocked(hasPendingPluginCreateIntent).mockResolvedValue(false);
		const runtime = makeRuntime();
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("new"),
			undefined,
			{ action: "status" },
			makeCallback(),
		);

		expect(vi.mocked(runCreate)).not.toHaveBeenCalled();
		expect(vi.mocked(runPluginStatus)).toHaveBeenCalledTimes(1);
	});
});

describe("validate", () => {
	it("accepts an owner turn carrying a structured subaction", async () => {
		const runtime = makeRuntime();
		const action = makeAction(true);

		await expect(
			action.validate(runtime, message("irrelevant"), undefined, {
				action: "list",
			}),
		).resolves.toBe(true);
	});

	it("rejects a non-owner turn even with a structured subaction", async () => {
		const runtime = makeRuntime();
		const action = makeAction(false);

		await expect(
			action.validate(runtime, message("list"), undefined, {
				action: "list",
			}),
		).resolves.toBe(false);
	});

	it("rejects turns lacking agent or entity context", async () => {
		const runtime = createMockRuntime({ agentId: "" });
		const action = makeAction(true);

		await expect(
			action.validate(runtime, message("list"), undefined, {
				action: "list",
			}),
		).resolves.toBe(false);
	});

	it("admits a plain owner turn through admin routing context metadata", async () => {
		const runtime = makeRuntime();
		const action = makeAction(true);
		const msg = message("hello there");
		msg.content.metadata = {
			__responseContext: { primaryContext: "admin" },
		};

		await expect(action.validate(runtime, msg, undefined, {})).resolves.toBe(
			true,
		);
	});

	it("rejects a structure-free owner turn with no active routing context", async () => {
		const runtime = makeRuntime();
		const action = makeAction(true);

		await expect(
			action.validate(runtime, message("hello there"), undefined, {}),
		).resolves.toBe(false);
	});

	it("admits a create choice reply only while an intent is pending", async () => {
		const runtime = makeRuntime();
		const action = makeAction(true);

		vi.mocked(isPluginCreateChoiceReply).mockReturnValue(true);
		vi.mocked(hasPendingPluginCreateIntent).mockResolvedValue(true);
		await expect(
			action.validate(runtime, message("new"), undefined, {}),
		).resolves.toBe(true);

		vi.mocked(hasPendingPluginCreateIntent).mockResolvedValue(false);
		await expect(
			action.validate(runtime, message("new"), undefined, {}),
		).resolves.toBe(false);
	});
});

describe("dispatch coverage across the remaining subactions", () => {
	it.each([
		["sync", runSync],
		["reinject", runReinject],
		["list_ejected", runListEjected],
		["details", runPluginDetails],
		["status", runPluginStatus],
		["enable", runEnablePlugin],
		["core_status", runCoreStatus],
	])("routes %s to its sub-handler", async (subaction, handler) => {
		const runtime = makeRuntime();
		const action = makeAction();

		await action.handler?.(
			runtime,
			message("go"),
			undefined,
			{ action: subaction, name: "plugin-pdf" },
			makeCallback(),
		);

		expect(handler).toHaveBeenCalledTimes(1);
	});
});
