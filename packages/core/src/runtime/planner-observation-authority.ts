/**
 * Process-local authority for receipt-backed planner read observations. The
 * action executor mints it only for canonically owned orchestrator reads, and
 * the planner projection rejects otherwise identical caller-authored fields.
 */
import type { Action, ActionResult } from "../types/components";
import { effectiveMachineSuccess } from "../types/effects";
import type { IAgentRuntime } from "../types/runtime";
import type { PlannerToolResult } from "./planner-types";

const ORCHESTRATOR_PLUGIN_NAME = "@elizaos/plugin-agent-orchestrator";
const APPROVED_TASKS_READ_RECEIPTS = new Map<
	string,
	{ actionNames: ReadonlySet<string>; reason: string }
>([
	[
		"agent-orchestrator.tasks.list_agents",
		{
			actionNames: new Set(["TASKS", "TASKS_LIST_AGENTS"]),
			reason: "The operation only read orchestrator state.",
		},
	],
	[
		"agent-orchestrator.tasks.history",
		{
			actionNames: new Set(["TASKS", "TASKS_HISTORY"]),
			reason: "The operation only read orchestrator state.",
		},
	],
	[
		"agent-orchestrator.tasks.share",
		{
			actionNames: new Set(["TASKS", "TASKS_SHARE"]),
			reason: "The operation only read orchestrator state.",
		},
	],
	[
		"agent-orchestrator.tasks.manage_issues",
		{
			actionNames: new Set(["TASKS", "TASKS_MANAGE_ISSUES"]),
			reason: "The operation only read provider issue state.",
		},
	],
]);
const settledReadObservations = new WeakMap<ActionResult, string>();
const authorizedPlannerObservations = new WeakMap<PlannerToolResult, string>();

/** Mint authority after the canonical action result has settled. */
export function authorizeCanonicalPlannerObservation(
	runtime: IAgentRuntime,
	action: Action,
	result: ActionResult,
): void {
	const ownership =
		typeof runtime.getPluginOwnership === "function"
			? runtime.getPluginOwnership(ORCHESTRATOR_PLUGIN_NAME)
			: null;
	const observation =
		typeof result.plannerObservation === "string"
			? result.plannerObservation.trim()
			: "";
	const receipts = result.effectReceipts;
	const receipt = receipts?.length === 1 ? receipts[0] : undefined;
	const approvedReceipt = receipt
		? APPROVED_TASKS_READ_RECEIPTS.get(receipt.operation)
		: undefined;
	if (
		!ownership?.actions.includes(action) ||
		!observation ||
		result.text !== undefined ||
		result.userFacingEffect !== "none" ||
		!receipt ||
		receipt.outcome !== "noop" ||
		receipt.resource.kind !== "orchestrator.request" ||
		receipt.artifacts.length !== 0 ||
		receipt.idempotency.key !== null ||
		receipt.idempotency.replayed ||
		!approvedReceipt?.actionNames.has(action.name) ||
		approvedReceipt.reason !== receipt.reason ||
		!effectiveMachineSuccess(result, receipts)
	) {
		return;
	}
	settledReadObservations.set(result, observation);
}

/** Transfer an executor-minted observation into the canonical planner result. */
export function transferPlannerObservationAuthority(
	source: ActionResult,
	target: PlannerToolResult,
): void {
	const observation = settledReadObservations.get(source);
	if (!observation) return;
	target.plannerObservation = observation;
	authorizedPlannerObservations.set(target, observation);
}

/** Read the observation authorized for this exact planner result. */
export function authorizedPlannerObservation(
	result: PlannerToolResult,
): string | undefined {
	return authorizedPlannerObservations.get(result);
}
