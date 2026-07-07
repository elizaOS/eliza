/**
 * Static source-tree audit that greps the real repo for direct
 * `action.handler(...)` callsites and asserts every one is classified in the
 * allowlist — so voiced-response handling stays intentional — with no stale
 * entries left behind. Reads files from disk; no model or database.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../../..",
);

const allowedCallsites = new Map<string, string>([
	[
		"packages/core/src/runtime/execute-planned-tool-call.ts",
		"central planned-action executor; attributes callbacks before message-service voice rewrite",
	],
	[
		"packages/core/src/runtime.ts",
		"hook-mode executor; attributes callbacks before message-service voice rewrite",
	],
	[
		"packages/core/src/features/advanced-planning/services/planning-service.ts",
		"advanced-planning executor; attributes callbacks before message-service voice rewrite",
	],
	[
		"packages/core/src/features/advanced-capabilities/actions/message.ts",
		"message router; attributes callbacks to routed child actions",
	],
	[
		"packages/core/src/features/advanced-capabilities/actions/room.ts",
		"room router; attributes callbacks to routed child actions",
	],
	[
		"packages/agent/src/actions/page-action-groups.ts",
		"page router; attributes callbacks to routed child actions",
	],
	[
		"packages/agent/src/api/chat-routes.ts",
		"direct chat task-dispatch bypass; rewrites callback text with TEXT_SMALL",
	],
	[
		"packages/agent/src/api/fallback-action-helpers.ts",
		"fallback action bypass; rewrites action callback output with TEXT_SMALL",
	],
	[
		"packages/scenario-runner/src/executor.ts",
		"scenario action turns; rewrites action response text with TEXT_SMALL",
	],
	[
		"plugins/plugin-agent-skills/src/actions/skill.ts",
		"skill router; attributes callbacks to routed child actions",
	],
	[
		"plugins/plugin-agent-skills/src/binance/direct-dispatch.ts",
		"Binance direct-skill dispatcher; attributes fallback/USE_SKILL callbacks and rewrites the routed action's response text for voice (rewriteFallbackActionText)",
	],
	[
		"plugins/plugin-linear/src/actions/routers.ts",
		"Linear router; attributes callbacks to routed child actions",
	],
	[
		"plugins/plugin-music/src/actions/music.ts",
		"music router; attributes callbacks to routed child actions",
	],
	[
		"plugins/plugin-personal-assistant/src/actions/calendar.ts",
		"calendar router; attributes callbacks to routed child actions",
	],
	[
		"plugins/plugin-app-manager/src/api/apps-routes.ts",
		"app-manager direct API dispatch; rewrites action response text with TEXT_SMALL",
	],
	[
		"plugins/plugin-coding-tools/src/services/coding-task-executor.ts",
		"coding-task executor; rewrites action response text with TEXT_SMALL",
	],
	[
		"plugins/plugin-agent-orchestrator/src/services/skill-lifeops-context-broker.ts",
		"LifeOps broker direct dispatch; rewrites action response text with TEXT_SMALL",
	],
	[
		"plugins/plugin-app-control/src/workers/app-worker-entry.ts",
		"internal app sandbox RPC; not a chat/user message surface",
	],
	[
		"plugins/plugin-app-control/src/actions/views.ts",
		"VIEWS close-alias dispatcher (CLOSE_VIEW / CLOSE_ALL_VIEWS); forwards to the underlying VIEWS handler",
	],
	[
		"plugins/plugin-commands/src/actions/handlers.ts",
		"slash-command dispatcher (/compact -> COMPACT_CONVERSATION via runCompactAction); forwards the original callback to the dispatched action and returns result.text as a CommandResult reply",
	],
	[
		"packages/core/src/services/message.ts",
		"shortcut-gate (runShortcutGate, #8792): fires a slash-command action; its callback only captures content.text (emits nothing) and the captured text is returned as a Stage1 direct_reply, so the normal message-service voice rewrite still applies",
	],
]);

const actionHandlerCallPattern = new RegExp(
	[
		"action\\.handler\\(",
		"route\\.action\\.handler\\(",
		"args\\.action\\.handler\\(",
		"childAction\\.handler\\(",
		"createTaskAction\\.handler\\(",
		"googleCalendarAction\\.handler\\(",
		"roomOpAction\\.handler\\(",
		"appAction\\.handler\\(",
		"playbackOp\\.handler\\(",
		"playAudio\\.handler\\(",
		"musicLibraryAction\\.handler\\(",
		"manageRouting\\.handler\\(",
		"manageZones\\.handler\\(",
	].join("|"),
);

const searchRoots = [
	"packages/core/src",
	"packages/agent/src",
	"packages/scenario-runner/src",
	"plugins",
];

const excludedDirNames = new Set([
	"dist",
	"node_modules",
	"test",
	"tests",
	"scripts",
]);

function isExcludedFile(relPath: string): boolean {
	return (
		relPath.endsWith(".d.ts") ||
		relPath.endsWith(".test.ts") ||
		relPath.endsWith(".spec.ts")
	);
}

function isScannableSource(name: string): boolean {
	return name.endsWith(".ts") || name.endsWith(".tsx");
}

function walk(absDir: string, found: Set<string>): void {
	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		const abs = path.join(absDir, entry.name);
		if (entry.isDirectory()) {
			if (excludedDirNames.has(entry.name)) continue;
			walk(abs, found);
			continue;
		}
		if (!entry.isFile() || !isScannableSource(entry.name)) continue;
		const rel = path.relative(repoRoot, abs).split(path.sep).join("/");
		if (isExcludedFile(rel)) continue;
		const content = readFileSync(abs, "utf8");
		if (actionHandlerCallPattern.test(content)) found.add(rel);
	}
}

describe("action handler callsite audit", () => {
	it("keeps direct action.handler callers classified for voiced response handling", () => {
		const foundSet = new Set<string>();
		for (const root of searchRoots) {
			walk(path.join(repoRoot, root), foundSet);
		}
		const found = [...foundSet].sort();
		const unexpected = found.filter((file) => !allowedCallsites.has(file));
		const stale = [...allowedCallsites.keys()].filter(
			(file) => !found.includes(file),
		);

		expect(unexpected).toEqual([]);
		expect(stale).toEqual([]);
	});
});
