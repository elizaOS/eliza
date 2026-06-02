import { execFileSync } from "node:child_process";
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
		"packages/agent/src/api/binance-skill-helpers.ts",
		"Binance direct/fallback bypass; rewrites raw output with TEXT_SMALL",
	],
	[
		"packages/scenario-runner/src/executor.ts",
		"scenario action turns; rewrites action response text with TEXT_SMALL",
	],
	[
		"plugins/plugin-steward-app/src/api/binance-skill-helpers.ts",
		"steward Binance direct/fallback bypass; rewrites raw output with TEXT_SMALL",
	],
	[
		"plugins/plugin-agent-skills/src/actions/skill.ts",
		"skill router; attributes callbacks to routed child actions",
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
		"plugins/plugin-lifeops/src/actions/calendar.ts",
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
]);

const actionHandlerCallPattern = [
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
].join("|");

describe("action handler callsite audit", () => {
	it("keeps direct action.handler callers classified for voiced response handling", () => {
		const output = execFileSync(
			"rg",
			[
				"-l",
				actionHandlerCallPattern,
				"packages/core/src",
				"packages/agent/src",
				"packages/scenario-runner/src",
				"plugins",
				"-g",
				"!**/dist/**",
				"-g",
				"!**/node_modules/**",
				"-g",
				"!**/*.d.ts",
				"-g",
				"!**/*.test.ts",
				"-g",
				"!**/*.spec.ts",
				"-g",
				"!**/test/**",
				"-g",
				"!**/tests/**",
				"-g",
				"!**/scripts/**",
			],
			{ cwd: repoRoot, encoding: "utf8" },
		);
		const found = output
			.split("\n")
			.map((line) => line.trim())
			.filter(Boolean)
			.sort();
		const unexpected = found.filter((file) => !allowedCallsites.has(file));
		const stale = [...allowedCallsites.keys()].filter(
			(file) => !found.includes(file),
		);

		expect(unexpected).toEqual([]);
		expect(stale).toEqual([]);
	});
});
