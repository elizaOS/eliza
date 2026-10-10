/** Host-neutral, single-task lifecycle. Hosts persist each transition atomically
 * before dispatch and revalidate at the actuator; this module never executes tools.
 * Interactive choices/approvals continue to use message-interaction sessions.
 */
import { ElizaError } from "../errors.ts";
import type {
	MessageInteractionAuthorizationDecision,
	MessageInteractionBindings,
} from "./interaction-sessions.ts";

export type TaskOwner = Pick<
	MessageInteractionBindings,
	"actorId" | "agentId" | "connector"
>;

import {
	type TaskEvent,
	type TaskOperationStatus,
	type TaskStatus,
	validateTaskEvent,
} from "./task-events.ts";

export type {
	TaskEvent,
	TaskOperationStatus,
	TaskStatus,
} from "./task-events.ts";
export { validateTaskEvent } from "./task-events.ts";
export interface TaskObservation {
	/** Opaque references only. Raw page text, input values and secrets stay outside this journal. */
	id: string;
	pageId: string;
	origin: string;
	version: number;
	inputRevision: number;
	observedAt: number;
}
/**
 * Error code for an action refused before anything reached the page. The
 * runtime records such an operation as failed, with the fixed evidence
 * reference below, instead of as an unknown outcome.
 */
export const TASK_ACTION_NOT_DISPATCHED = "TASK_ACTION_NOT_DISPATCHED";
export const TASK_ACTION_NOT_DISPATCHED_REF = "not-dispatched";
export interface TaskActionProposal {
	id: string;
	taskId: string;
	epoch: number;
	observationId: string;
	observationVersion: number;
	inputRevision: number;
	targetRef: string;
	/**
	 * The one reviewed adapter target the host chose for this action. When it
	 * is set, the adapter refuses the action unless `targetRef` is that target.
	 */
	expectedSelector?: string;
	valueRef?: string;
	/** Capability comes from a trusted adapter's classification, never page/model assertions. */
	capability: string;
	authorizationId: string;
	expiresAt: number;
}
export interface TaskOperation {
	proposal: TaskActionProposal;
	status: TaskOperationStatus;
	evidenceRef?: string;
}
export interface InteractiveTask {
	schemaVersion: 1;
	id: string;
	owner: TaskOwner;
	goalRef: string;
	revision: number;
	epoch: number;
	status: TaskStatus;
	authorization: MessageInteractionAuthorizationDecision;
	allowedCapabilities: string[];
	allowedOrigins: string[];
	observation: TaskObservation | null;
	operations: TaskOperation[];
	updatedAt: number;
}
export interface TaskContext {
	owner: TaskOwner;
	expectedRevision: number;
	now: number;
}
export type TaskTransition =
	| { type: "observe"; observation: TaskObservation }
	| { type: "resume"; observation: TaskObservation }
	| { type: "pause" | "cancel" | "recover" | "revoke" | "complete" }
	| { type: "prepare"; proposal: TaskActionProposal }
	| { type: "dispatch"; operationId: string }
	| {
			type: "result" | "reconcile";
			operationId: string;
			status: "succeeded" | "failed" | "unknown";
			evidenceRef?: string;
	  };

function reject(message: string, code = "TASK_INVALID"): never {
	throw new ElizaError(message, { code });
}
function shape(
	value: unknown,
	required: string[],
	optional: string[] = [],
): void {
	if (
		!value ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.getPrototypeOf(value) !== Object.prototype
	)
		reject("Expected a plain task record");
	const keys = Object.keys(value);
	if (
		required.some((key) => !keys.includes(key)) ||
		keys.some((key) => !required.includes(key) && !optional.includes(key))
	)
		reject("Unexpected task record fields");
}
function id(value: unknown): asserts value is string {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,255}$/.test(value)
	)
		reject("Expected an opaque task reference");
}
function counter(value: unknown): asserts value is number {
	if (!Number.isSafeInteger(value) || Number(value) < 0)
		reject("Invalid task counter");
}
function origin(value: string): void {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		reject("Invalid task origin");
	}
	if (
		parsed.protocol !== "https:" ||
		parsed.origin !== value ||
		parsed.username ||
		parsed.password
	)
		reject("Task origin must be an exact HTTPS origin");
}
export function sameTaskOwner(a: TaskOwner, b: TaskOwner): boolean {
	return (
		a.actorId === b.actorId &&
		a.agentId === b.agentId &&
		a.connector.source === b.connector.source &&
		a.connector.accountId === b.connector.accountId
	);
}
function validateOwner(owner: TaskOwner): void {
	shape(owner, ["actorId", "agentId", "connector"]);
	shape(owner.connector, ["source", "accountId"]);
	id(owner.actorId);
	id(owner.agentId);
	id(owner.connector.source);
	id(owner.connector.accountId);
}
function validateObservation(value: TaskObservation): void {
	shape(value, [
		"id",
		"pageId",
		"origin",
		"version",
		"inputRevision",
		"observedAt",
	]);
	id(value.id);
	id(value.pageId);
	origin(value.origin);
	counter(value.version);
	counter(value.inputRevision);
	counter(value.observedAt);
}
function validateProposal(value: TaskActionProposal): void {
	shape(
		value,
		[
			"id",
			"taskId",
			"epoch",
			"observationId",
			"observationVersion",
			"inputRevision",
			"targetRef",
			"capability",
			"authorizationId",
			"expiresAt",
		],
		["valueRef", "expectedSelector"],
	);
	id(value.id);
	id(value.taskId);
	id(value.observationId);
	id(value.targetRef);
	id(value.capability);
	id(value.authorizationId);
	if (value.valueRef !== undefined) id(value.valueRef);
	if (
		value.expectedSelector !== undefined &&
		(typeof value.expectedSelector !== "string" ||
			!value.expectedSelector ||
			value.expectedSelector.length > 256 ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Reject control characters in selectors.
			/[\x00-\x1f\x7f]/.test(value.expectedSelector))
	)
		reject("Invalid expected target");
	counter(value.epoch);
	counter(value.observationVersion);
	counter(value.inputRevision);
	counter(value.expiresAt);
}
/** Validate journal structure at the trusted storage boundary before use. */
export function validateInteractiveTask(value: InteractiveTask): void {
	shape(value, [
		"schemaVersion",
		"id",
		"owner",
		"goalRef",
		"revision",
		"epoch",
		"status",
		"authorization",
		"allowedCapabilities",
		"allowedOrigins",
		"observation",
		"operations",
		"updatedAt",
	]);
	if (value.schemaVersion !== 1) reject("Unsupported task schema");
	id(value.id);
	id(value.goalRef);
	validateOwner(value.owner);
	counter(value.revision);
	counter(value.epoch);
	counter(value.updatedAt);
	if (
		![
			"active",
			"paused",
			"blocked",
			"waiting",
			"completed",
			"cancelled",
		].includes(value.status)
	)
		reject("Invalid task status");
	const auth = value.authorization;
	shape(auth, [
		"decisionId",
		"policyRevision",
		"decidedAt",
		"state",
		"revokedAt",
	]);
	if (!auth || !["active", "revoked"].includes(auth.state))
		reject("Invalid task authorization");
	id(auth.decisionId);
	id(auth.policyRevision);
	if (
		!Number.isFinite(Date.parse(auth.decidedAt)) ||
		(auth.revokedAt !== null && !Number.isFinite(Date.parse(auth.revokedAt)))
	)
		reject("Invalid authorization time");
	if (
		!Array.isArray(value.allowedOrigins) ||
		!Array.isArray(value.allowedCapabilities) ||
		!Array.isArray(value.operations)
	)
		reject("Invalid task policy or operations");
	value.allowedOrigins.forEach(origin);
	value.allowedCapabilities.forEach(id);
	if ((auth.state === "active") !== (auth.revokedAt === null))
		reject("Authorization revocation is inconsistent");
	if (value.observation !== null) {
		validateObservation(value.observation);
		if (
			!value.allowedOrigins.includes(value.observation.origin) ||
			value.observation.observedAt > value.updatedAt
		)
			reject("Persisted observation is outside task scope");
	}
	const seen = new Set<string>();
	for (const operation of value.operations) {
		shape(operation, ["proposal", "status"], ["evidenceRef"]);
		validateProposal(operation.proposal);
		if (
			operation.proposal.taskId !== value.id ||
			seen.has(operation.proposal.id)
		)
			reject("Invalid operation identity");
		seen.add(operation.proposal.id);
		if (
			![
				"prepared",
				"dispatched",
				"succeeded",
				"failed",
				"cancelled",
				"unknown",
			].includes(operation.status)
		)
			reject("Invalid operation status");
		if (operation.evidenceRef !== undefined) id(operation.evidenceRef);
		if (
			["succeeded", "failed"].includes(operation.status) &&
			!operation.evidenceRef
		)
			reject("Resolved operation is missing evidence");
		if (operation.proposal.epoch > value.epoch)
			reject("Operation epoch is ahead of the task");
	}
	if (
		value.operations.filter((op) =>
			["prepared", "dispatched", "unknown"].includes(op.status),
		).length > 1
	)
		reject("Multiple unresolved task operations");
	const unresolved = value.operations.find((operation) =>
		["prepared", "dispatched", "unknown"].includes(operation.status),
	);
	if ((value.status === "waiting") !== (unresolved?.status === "dispatched"))
		reject("Waiting task and dispatched operation disagree");
	if (unresolved?.status === "prepared" && value.status !== "active")
		reject("Inactive task has a prepared operation");
	if (
		unresolved?.status === "unknown" &&
		!["blocked", "paused", "cancelled"].includes(value.status)
	)
		reject("Unknown outcome requires reconciliation");
	if (value.status === "blocked" && unresolved?.status !== "unknown")
		reject("Blocked task is missing its unknown operation");
	if (auth.state === "revoked" && ["active", "waiting"].includes(value.status))
		reject("Revoked task cannot be active");
}
export function createInteractiveTask(input: {
	id: string;
	owner: TaskOwner;
	goalRef: string;
	now: number;
	authorization: MessageInteractionAuthorizationDecision;
	allowedCapabilities: string[];
	allowedOrigins: string[];
}): InteractiveTask {
	const task: InteractiveTask = {
		schemaVersion: 1,
		id: input.id,
		owner: structuredClone(input.owner),
		goalRef: input.goalRef,
		revision: 0,
		epoch: 0,
		status: "active",
		authorization: structuredClone(input.authorization),
		allowedCapabilities: [...input.allowedCapabilities],
		allowedOrigins: [...input.allowedOrigins],
		observation: null,
		operations: [],
		updatedAt: input.now,
	};
	validateInteractiveTask(task);
	if (task.authorization.state !== "active")
		reject("Task authorization is revoked", "TASK_REVOKED");
	return task;
}
function checkObservation(
	task: InteractiveTask,
	observation: TaskObservation,
	now: number,
): void {
	validateObservation(observation);
	if (!task.allowedOrigins.includes(observation.origin))
		reject("Observation is outside task scope", "TASK_SCOPE_CHANGED");
	if (observation.observedAt > now) reject("Observation is from the future");
	const previous = task.observation;
	if (previous && observation.version <= previous.version)
		reject("Observation must advance monotonically", "TASK_STALE_OBSERVATION");
}
function checkDispatch(
	task: InteractiveTask,
	proposal: TaskActionProposal,
	now: number,
): void {
	if (task.status !== "active" || task.authorization.state !== "active")
		reject("Task is not authorized to act", "TASK_NOT_ACTIVE");
	const observed = task.observation;
	if (
		!observed ||
		proposal.taskId !== task.id ||
		proposal.epoch !== task.epoch ||
		proposal.observationId !== observed.id ||
		proposal.observationVersion !== observed.version ||
		proposal.inputRevision !== observed.inputRevision
	)
		reject("Action no longer matches the observed task", "TASK_STALE_ACTION");
	if (
		proposal.authorizationId !== task.authorization.decisionId ||
		!task.allowedCapabilities.includes(proposal.capability)
	)
		reject("Action is outside task authorization", "TASK_ACTION_DENIED");
	if (proposal.expiresAt <= now) reject("Action expired", "TASK_STALE_ACTION");
}
/** Pure transition. Storage must compare-and-swap revision and fsync before an effect.
 * Actuators independently check the committed proposal against their current page.
 */
export function transitionInteractiveTask(
	previous: InteractiveTask,
	context: TaskContext,
	transition: TaskTransition,
): { task: InteractiveTask; event: TaskEvent } {
	validateInteractiveTask(previous);
	validateOwner(context.owner);
	counter(context.now);
	counter(context.expectedRevision);
	if (!sameTaskOwner(previous.owner, context.owner))
		reject("Task belongs to another owner", "TASK_WRONG_OWNER");
	if (context.expectedRevision !== previous.revision)
		reject("Task revision changed", "TASK_CONFLICT");
	if (context.now < previous.updatedAt)
		reject("Task clock moved backwards", "TASK_CLOCK");
	const task = structuredClone(previous);
	const unresolved = task.operations.find((op) =>
		["prepared", "dispatched", "unknown"].includes(op.status),
	);
	const terminal = ["completed", "cancelled"].includes(task.status);
	if (terminal && !["reconcile", "recover", "revoke"].includes(transition.type))
		reject("Task has ended", "TASK_ENDED");
	switch (transition.type) {
		case "observe":
		case "resume": {
			if (task.authorization.state !== "active")
				reject("Task authorization is revoked", "TASK_REVOKED");
			if (transition.type === "resume" && task.status !== "paused")
				reject("Only a paused task can resume");
			if (unresolved && ["dispatched", "unknown"].includes(unresolved.status))
				reject(
					"Resolve the previous operation before acting",
					"TASK_UNKNOWN_OUTCOME",
				);
			checkObservation(task, transition.observation, context.now);
			if (unresolved?.status === "prepared") unresolved.status = "cancelled";
			task.observation = structuredClone(transition.observation);
			if (transition.type === "resume") task.status = "active";
			break;
		}
		case "pause":
		case "cancel":
		case "recover":
		case "revoke": {
			task.epoch++;
			if (unresolved?.status === "prepared") unresolved.status = "cancelled";
			else if (unresolved?.status === "dispatched")
				unresolved.status = "unknown";
			if (transition.type === "revoke") {
				task.authorization.state = "revoked";
				task.authorization.revokedAt = new Date(context.now).toISOString();
			}
			if (!terminal)
				task.status = transition.type === "cancel" ? "cancelled" : "paused";
			break;
		}
		case "prepare": {
			validateProposal(transition.proposal);
			checkDispatch(task, transition.proposal, context.now);
			if (unresolved) reject("An operation is already unresolved", "TASK_BUSY");
			if (
				task.operations.some((op) => op.proposal.id === transition.proposal.id)
			)
				reject("Operation cannot be replayed", "TASK_REPLAY");
			task.operations.push({
				proposal: structuredClone(transition.proposal),
				status: "prepared",
			});
			break;
		}
		case "dispatch": {
			if (
				!unresolved ||
				unresolved.proposal.id !== transition.operationId ||
				unresolved.status !== "prepared"
			)
				reject("No matching prepared operation", "TASK_REPLAY");
			checkDispatch(task, unresolved.proposal, context.now);
			unresolved.status = "dispatched";
			task.status = "waiting";
			break;
		}
		case "result":
		case "reconcile": {
			const operation = task.operations.find(
				(op) => op.proposal.id === transition.operationId,
			);
			if (
				!operation ||
				(transition.type === "result"
					? operation.status !== "dispatched"
					: operation.status !== "unknown")
			)
				reject("Result cannot replace this operation", "TASK_REPLAY");
			if (!["succeeded", "failed", "unknown"].includes(transition.status))
				reject("Invalid result");
			if (transition.status !== "unknown" && !transition.evidenceRef)
				reject("A resolved outcome requires evidence");
			if (transition.evidenceRef !== undefined) id(transition.evidenceRef);
			operation.status = transition.status;
			operation.evidenceRef = transition.evidenceRef;
			if (transition.type === "reconcile" && transition.status !== "unknown") {
				// Readback authority must not become effect authority in the same epoch.
				// Commit the fence with the result so a crash cannot strand a narrower
				// native binding or restore a previously actionable observation.
				task.epoch++;
				task.observation = null;
			}
			if (task.status === "waiting")
				task.status = transition.status === "unknown" ? "blocked" : "active";
			if (
				task.status === "blocked" &&
				transition.type === "reconcile" &&
				transition.status !== "unknown"
			)
				task.status = "paused";
			break;
		}
		case "complete":
			if (unresolved)
				reject(
					"Cannot finish with an unresolved operation",
					"TASK_UNKNOWN_OUTCOME",
				);
			task.status = "completed";
			task.epoch++;
			break;
		default:
			reject("Unknown task transition");
	}
	task.revision++;
	task.updatedAt = context.now;
	validateInteractiveTask(task);
	const event: TaskEvent = {
		eventId: `${task.id}#${task.revision}`,
		schemaVersion: 1,
		taskId: task.id,
		sequence: task.revision,
		epoch: task.epoch,
		kind: transition.type,
		at: context.now,
		status: task.status,
	};
	if ("operationId" in transition) event.operationId = transition.operationId;
	if (transition.type === "prepare") event.operationId = transition.proposal.id;
	if (event.operationId)
		event.operationStatus = task.operations.find(
			(operation) => operation.proposal.id === event.operationId,
		)?.status;
	validateTaskEvent(event);
	return { task, event };
}
