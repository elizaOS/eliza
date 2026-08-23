/** Live-model selection guard: Devices & Runtimes reads route to RUNTIMES, never VIEWS. */

import type { CapturedAction } from "@elizaos/scenario-runner/schema";
import { scenario } from "@elizaos/scenario-runner/schema";
import {
	jsonResponse,
	registerAppControlHttpHandler,
	resetAppControlHttpLoopback,
} from "../../../../packages/scenario-runner/test/scenarios/_helpers/app-control-http-loopback";

function expectRuntimeList(execution: {
	actionsCalled: CapturedAction[];
}): string | undefined {
	const runtimes = execution.actionsCalled.find(
		(candidate) => candidate.actionName === "RUNTIMES",
	);
	if (!runtimes) {
		return `expected RUNTIMES, saw ${execution.actionsCalled.map((call) => call.actionName).join(", ") || "none"}`;
	}
	if (execution.actionsCalled.some((call) => call.actionName === "VIEWS")) {
		return "expected semantic RUNTIMES action, not Settings view navigation";
	}
	return runtimes.result?.success === true
		? undefined
		: `RUNTIMES failed: ${JSON.stringify(runtimes.result)}`;
}

export default scenario({
	lane: "live-only",
	id: "runtime-management-list",
	title: "RUNTIMES action lists saved Devices & Runtimes",
	domain: "app-control",
	tags: ["app-control", "devices", "runtimes", "action-selection"],
	isolation: "per-scenario",
	requires: { plugins: ["@elizaos/plugin-app-control"] },
	seed: [
		{
			type: "custom",
			name: "register runtime-management loopback",
			apply: () => {
				resetAppControlHttpLoopback();
				registerAppControlHttpHandler((request) =>
					request.method === "POST" &&
					request.pathname === "/api/runtime/manage"
						? jsonResponse({
								ok: true,
								op: "list",
								data: {
									runtimes: [
										{ id: "local", label: "This Mac", kind: "local" },
									],
								},
							})
						: undefined,
				);
				return undefined;
			},
		},
	],
	rooms: [{ id: "main", source: "client_chat", title: "Runtime List" }],
	turns: [
		{
			kind: "message",
			name: "user-lists-runtimes",
			text: "Show me my linked devices and saved runtimes.",
			expectedActions: ["RUNTIMES"],
			assertTurn: expectRuntimeList,
		},
	],
	finalChecks: [
		{ type: "selectedAction", actionName: "RUNTIMES" },
		{ type: "actionCalled", actionName: "RUNTIMES", status: "success" },
		{
			type: "custom",
			name: "cleanup loopback",
			predicate: () => {
				resetAppControlHttpLoopback();
				return undefined;
			},
		},
	],
});
