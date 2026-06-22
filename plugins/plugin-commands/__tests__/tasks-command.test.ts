/**
 * `/tasks` command — lists active coding sub-agent sessions and their progress.
 *
 * The command is connector-safe: it is a gate-safe agent-target command that
 * resolves deterministically before the LLM, on every surface. It reads the
 * orchestrator's session service at runtime via `runtime.getService(...)` (the
 * same lookup the orchestrator's own actions use), so plugin-commands keeps its
 * single `@elizaos/core` dependency — there is no import of
 * `@elizaos/plugin-agent-orchestrator`.
 */

import type { IAgentRuntime, Memory } from "@elizaos/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
	commandActions,
	commandShortcuts,
	GATE_SAFE_COMMAND_KEYS,
	resolveCommand,
} from "../src/actions";
import { findCommandByKey, initForRuntime } from "../src/registry";

interface FakeSession {
	id: string;
	name?: string;
	agentType?: string;
	workdir?: string;
	status?: string;
	metadata?: { label?: string };
}

/**
 * Build a runtime whose `getService("ACP_SERVICE")` returns a fake orchestrator
 * session service exposing `listSessions()`. When `sessions` is undefined the
 * runtime exposes NO ACP service (simulating an agent with no orchestrator).
 */
function makeRuntime(sessions?: FakeSession[]): IAgentRuntime {
	const service =
		sessions === undefined ? undefined : { listSessions: () => sessions };
	return {
		agentId: "agent-1",
		character: { name: "Eliza", settings: {} },
		getSetting: () => null,
		getService: (name: string) => (name === "ACP_SERVICE" ? service : null),
	} as unknown as IAgentRuntime;
}

function msg(text: string, source = "client_chat"): Memory {
	return {
		id: "00000000-0000-0000-0000-000000000001",
		entityId: "00000000-0000-0000-0000-0000000000aa",
		roomId: "room-1",
		content: { text, source },
	} as unknown as Memory;
}

describe("/tasks command registration", () => {
	beforeEach(() => {
		initForRuntime("agent-1");
	});

	it("is a registered command with connector-safe aliases", () => {
		const def = findCommandByKey("tasks");
		expect(def).toBeDefined();
		expect(def?.textAliases).toContain("/tasks");
		expect(def?.textAliases).toContain("/coding");
		// scope "both" → offered on text + native surfaces (connectors included).
		expect(def?.scope).toBe("both");
		// No auth/elevation gate → connectors can list status freely.
		expect(def?.requiresAuth).toBeFalsy();
		expect(def?.requiresElevated).toBeFalsy();
	});

	it("is gate-safe (resolves deterministically before the LLM)", () => {
		expect(GATE_SAFE_COMMAND_KEYS).toContain("tasks");
	});

	it("registers a TASKS_COMMAND action and a slash shortcut", async () => {
		const action = commandActions.find((a) => a.name === "TASKS_COMMAND");
		expect(action).toBeDefined();
		const runtime = makeRuntime([]);
		expect(await action?.validate(runtime, msg("/tasks"))).toBe(true);
		expect(await action?.validate(runtime, msg("/help"))).toBe(false);
		// Slash-only similes — never natural language.
		for (const simile of action?.similes ?? []) {
			expect(simile.startsWith("/")).toBe(true);
		}

		const shortcut = commandShortcuts.find((s) => s.id === "cmd:tasks");
		expect(shortcut).toBeDefined();
		expect(shortcut?.kind).toBe("explicit");
		if (shortcut?.target.kind === "action") {
			expect(shortcut.target.name).toBe("TASKS_COMMAND");
		}
	});
});

describe("/tasks listing", () => {
	beforeEach(() => {
		initForRuntime("agent-1");
	});

	it("lists active sub-agent sessions with label, status, and workdir", async () => {
		const runtime = makeRuntime([
			{
				id: "abcdef0123456789",
				agentType: "codex",
				status: "running",
				workdir: "/tmp/proj-a",
				metadata: { label: "Build login page" },
			},
			{
				id: "fedcba9876543210",
				name: "refactor-auth",
				agentType: "claude",
				status: "tool_running",
				workdir: "/tmp/proj-b",
			},
		]);

		const r = await resolveCommand(runtime, msg("/tasks"));
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("Active coding sub-agents (2):");
		// Label preference: explicit metadata label, then name, then short id.
		expect(r.reply).toContain("Build login page");
		expect(r.reply).toContain("refactor-auth");
		// Status + agent type + workdir are surfaced as progress signal.
		expect(r.reply).toContain("running");
		expect(r.reply).toContain("tool_running");
		expect(r.reply).toContain("codex");
		expect(r.reply).toContain("/tmp/proj-a");
	});

	it("filters out terminal (finished) sessions", async () => {
		const runtime = makeRuntime([
			{ id: "00000001aaaa", agentType: "codex", status: "running" },
			{ id: "00000002bbbb", agentType: "codex", status: "completed" },
			{ id: "00000003cccc", agentType: "codex", status: "cancelled" },
		]);

		const r = await resolveCommand(runtime, msg("/tasks"));
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("Active coding sub-agents (1):");
		expect(r.reply).toContain("00000001");
		expect(r.reply).not.toContain("00000002");
		expect(r.reply).not.toContain("00000003");
	});

	it("reports an empty listing when no sessions are active", async () => {
		const runtime = makeRuntime([]);
		const r = await resolveCommand(runtime, msg("/tasks"));
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("No active coding sub-agent sessions.");
	});

	it("degrades gracefully when no orchestrator is loaded", async () => {
		const runtime = makeRuntime(undefined);
		const r = await resolveCommand(runtime, msg("/tasks"));
		// Still handled (deterministic, connector-safe) — just no data to show.
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("No coding orchestrator is available");
	});

	it("resolves via the /coding alias too", async () => {
		const runtime = makeRuntime([
			{ id: "00000001aaaa", agentType: "codex", status: "running" },
		]);
		const r = await resolveCommand(runtime, msg("/coding"));
		expect(r.handled).toBe(true);
		expect(r.reply).toContain("Active coding sub-agents (1):");
	});
});
