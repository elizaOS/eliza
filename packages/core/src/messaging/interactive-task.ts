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
/**
 * A host-authorized origin a running task was extended to, for example the
 * sign-in service a government site sends the person to. Never automatic: the
 * host adds it with "extend-origin" only after its own safety check passed.
 */
export interface TaskOriginGrant {
	origin: string;
	/** Opaque reference to the host's safety check (blocklist, look-alike) for this origin. */
	checkRef: string;
	/** Task epoch the grant took effect in. */
	epoch: number;
	grantedAt: number;
	/** Set by "retract-origin"; the origin then leaves `allowedOrigins`. */
	retractedAt: number | null;
}
/** One observed move of the page between origins of an extended task. */
export interface TaskOriginStep {
	origin: string;
	epoch: number;
	at: number;
}
/** At most this many grants per task, retracted ones included. */
export const MAX_TASK_ORIGIN_GRANTS = 16;
/** The task keeps the latest steps; the event journal keeps every observed origin. */
export const MAX_TASK_ORIGIN_CHAIN = 64;
/**
 * How an operation ended, as an actuator or readback reports it. A resolved
 * outcome always names its evidence; an unknown one may name what was seen.
 */
export type TaskOutcome =
	| { status: "succeeded" | "failed"; evidenceRef: string }
	| { status: "unknown"; evidenceRef?: string };
/** An operation carries evidence only once it ran: never while prepared or dispatched, or once cancelled. */
export type TaskOperation =
	| {
			proposal: TaskActionProposal;
			status: "prepared" | "dispatched";
			evidenceRef?: never;
	  }
	| { proposal: TaskActionProposal; status: "cancelled"; evidenceRef?: never }
	| ({ proposal: TaskActionProposal } & TaskOutcome);
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
	/**
	 * Present, with `originChain`, only once the host extended the task beyond
	 * its starting origins. A task bound to one origin has neither field.
	 */
	originGrants?: TaskOriginGrant[];
	/** Observed origin moves, oldest first, for example ssa.gov, login.gov, ssa.gov. */
	originChain?: TaskOriginStep[];
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
	/**
	 * Trusted host only: a new epoch for a new browser binding, for example a
	 * new action target. The task stays active and needs a fresh observation.
	 * The guide never pauses a task to take a new binding: a pause is her Stop
	 * or a host safety stop, and only her Resume ends it.
	 */
	| { type: "rebind" }
	| { type: "prepare"; proposal: TaskActionProposal }
	/**
	 * Trusted host only, after its own safety check of this exact origin passed.
	 * Adds the origin to `allowedOrigins` and starts a new epoch that needs a
	 * fresh observation. Both scope changes clear the current observation.
	 */
	| { type: "extend-origin"; origin: string; checkRef: string }
	/** Remove an origin an "extend-origin" added; the starting origins stay. */
	| { type: "retract-origin"; origin: string }
	| { type: "dispatch"; operationId: string }
	| ({ type: "result" | "reconcile"; operationId: string } & TaskOutcome);

// Keyed by the union, so a status added to it must be added here too.
const TASK_STATUSES: readonly unknown[] = Object.keys({
	active: true,
	paused: true,
	blocked: true,
	waiting: true,
	completed: true,
	cancelled: true,
} satisfies Record<TaskStatus, true>);
const TASK_OPERATION_STATUSES: readonly unknown[] = Object.keys({
	prepared: true,
	dispatched: true,
	succeeded: true,
	failed: true,
	cancelled: true,
	unknown: true,
} satisfies Record<TaskOperationStatus, true>);
type UnresolvedOperation = Extract<
	TaskOperation,
	{ status: "prepared" | "dispatched" | "unknown" }
>;
function isUnresolved(
	operation: TaskOperation,
): operation is UnresolvedOperation {
	return ["prepared", "dispatched", "unknown"].includes(operation.status);
}
/** Transitions a finished task still accepts: they only narrow what it may do. */
const AFTER_END: readonly TaskTransition["type"][] = [
	"reconcile",
	"recover",
	"revoke",
	"retract-origin",
];

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
function validateOriginScope(value: InteractiveTask): void {
	const { originGrants: grants, originChain: chain } = value;
	if ((grants === undefined) !== (chain === undefined))
		reject("Task origin grants and chain disagree");
	if (grants === undefined || chain === undefined) return;
	if (
		!Array.isArray(grants) ||
		!Array.isArray(chain) ||
		grants.length > MAX_TASK_ORIGIN_GRANTS ||
		chain.length > MAX_TASK_ORIGIN_CHAIN
	)
		reject("Invalid task origin history");
	const active = new Set<string>();
	for (const grant of grants) {
		shape(grant, ["origin", "checkRef", "epoch", "grantedAt", "retractedAt"]);
		origin(grant.origin);
		id(grant.checkRef);
		counter(grant.epoch);
		counter(grant.grantedAt);
		if (
			grant.epoch > value.epoch ||
			grant.grantedAt > value.updatedAt ||
			(grant.retractedAt !== null &&
				(!Number.isSafeInteger(grant.retractedAt) ||
					grant.retractedAt < grant.grantedAt ||
					grant.retractedAt > value.updatedAt))
		)
			reject("Invalid task origin grant");
		if (grant.retractedAt !== null) continue;
		if (
			active.has(grant.origin) ||
			!value.allowedOrigins.includes(grant.origin)
		)
			reject("Active origin grant is outside task scope");
		active.add(grant.origin);
	}
	if (
		grants.some(
			(grant) =>
				grant.retractedAt !== null &&
				value.allowedOrigins.includes(grant.origin) &&
				!active.has(grant.origin),
		)
	)
		reject("Retracted origin is still in task scope");
	let previous: TaskOriginStep | undefined;
	for (const step of chain) {
		shape(step, ["origin", "epoch", "at"]);
		origin(step.origin);
		counter(step.epoch);
		counter(step.at);
		if (
			step.epoch > value.epoch ||
			step.at > value.updatedAt ||
			(previous &&
				(step.origin === previous.origin ||
					step.epoch < previous.epoch ||
					step.at < previous.at))
		)
			reject("Invalid task origin chain");
		previous = step;
	}
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
	shape(
		value,
		[
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
		],
		["originGrants", "originChain"],
	);
	if (value.schemaVersion !== 1) reject("Unsupported task schema");
	id(value.id);
	id(value.goalRef);
	validateOwner(value.owner);
	counter(value.revision);
	counter(value.epoch);
	counter(value.updatedAt);
	if (!TASK_STATUSES.includes(value.status)) reject("Invalid task status");
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
	validateOriginScope(value);
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
		if (!TASK_OPERATION_STATUSES.includes(operation.status))
			reject("Invalid operation status");
		if (operation.evidenceRef !== undefined) {
			id(operation.evidenceRef);
			if (!["succeeded", "failed", "unknown"].includes(operation.status))
				reject("Operation has evidence before it ran");
		} else if (["succeeded", "failed"].includes(operation.status))
			reject("Resolved operation is missing evidence");
		if (operation.proposal.epoch > value.epoch)
			reject("Operation epoch is ahead of the task");
	}
	if (value.operations.filter(isUnresolved).length > 1)
		reject("Multiple unresolved task operations");
	const unresolved = value.operations.find(isUnresolved);
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
	// The fence: a prepared operation was planned against this epoch, this
	// observation and this authorization, so a stale or tampered record is
	// refused here and not only by the recheck at dispatch. A dispatched
	// operation is not fenced: its effect may already have happened, so the
	// record must still load and recover to unknown for a readback, and a
	// refusal here would also hold the owner's unfinished-task slot forever.
	if (
		unresolved?.status === "prepared" &&
		!matchesTask(value, unresolved.proposal)
	)
		reject("Pending operation no longer matches its task");
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
/** Extended tasks only: append a move to another origin, keeping the latest steps. */
function recordOriginStep(
	task: InteractiveTask,
	observation: TaskObservation,
): void {
	const chain = task.originChain;
	const last = chain?.at(-1);
	if (!chain || last?.origin === observation.origin) return;
	chain.push({
		origin: observation.origin,
		epoch: task.epoch,
		// Observation clocks need not be monotonic; the chain must stay ordered
		// or the stored task would no longer validate.
		at: Math.max(observation.observedAt, last?.at ?? 0),
	});
	if (chain.length > MAX_TASK_ORIGIN_CHAIN)
		chain.splice(0, chain.length - MAX_TASK_ORIGIN_CHAIN);
}
function isCurrentPlan(
	task: InteractiveTask,
	proposal: TaskActionProposal,
): boolean {
	const observed = task.observation;
	return (
		observed !== null &&
		proposal.taskId === task.id &&
		proposal.epoch === task.epoch &&
		proposal.observationId === observed.id &&
		proposal.observationVersion === observed.version &&
		proposal.inputRevision === observed.inputRevision
	);
}
function isAuthorizedPlan(
	task: InteractiveTask,
	proposal: TaskActionProposal,
): boolean {
	return (
		task.authorization.state === "active" &&
		proposal.authorizationId === task.authorization.decisionId &&
		task.allowedCapabilities.includes(proposal.capability)
	);
}
function matchesTask(task: InteractiveTask, proposal: TaskActionProposal) {
	return isCurrentPlan(task, proposal) && isAuthorizedPlan(task, proposal);
}
function checkDispatch(
	task: InteractiveTask,
	proposal: TaskActionProposal,
	now: number,
): void {
	if (task.status !== "active" || task.authorization.state !== "active")
		reject("Task is not authorized to act", "TASK_NOT_ACTIVE");
	if (!isCurrentPlan(task, proposal))
		reject("Action no longer matches the observed task", "TASK_STALE_ACTION");
	if (!isAuthorizedPlan(task, proposal))
		reject("Action is outside task authorization", "TASK_ACTION_DENIED");
	// Expiry is the one part of this check that time alone can break, so it is
	// not part of the stored invariant.
	if (proposal.expiresAt <= now) reject("Action expired", "TASK_STALE_ACTION");
}
/** Operations change by replacement, so each status keeps exactly its own fields. */
function replaceOperation(
	task: InteractiveTask,
	operation: TaskOperation,
	next: TaskOperation,
): void {
	task.operations[task.operations.indexOf(operation)] = next;
}
function setStatus(
	task: InteractiveTask,
	operation: UnresolvedOperation,
	status: "cancelled" | "dispatched" | "unknown",
): void {
	replaceOperation(task, operation, { proposal: operation.proposal, status });
}
/** Every transition type has a case (checked at compile time); hosts still pass
 * transitions from outside the type system, so the default refuses at runtime. */
function unknownTransition(_transition: never): never {
	reject("Unknown task transition");
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
	// The revision orders the journal and the epoch fences effects; wall time is
	// audit data and the input to expiry. A clock that steps back must not refuse
	// a stop, so time never moves backwards in the task: it stays at updatedAt.
	// The cost is the other direction: a transition committed while the clock
	// ran ahead stores that future time, and after the clock is corrected every
	// new action the actuator leases from real time has already expired, so the
	// task cannot act until real time reaches updatedAt. Stops still work; the
	// way out is to cancel and start a new task.
	const now = Math.max(context.now, previous.updatedAt);
	const task = structuredClone(previous);
	const unresolved = task.operations.find(isUnresolved);
	const terminal = ["completed", "cancelled"].includes(task.status);
	// Narrowing scope stays possible after a task ends, like revocation.
	if (terminal && !AFTER_END.includes(transition.type))
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
			checkObservation(task, transition.observation, now);
			if (unresolved?.status === "prepared")
				setStatus(task, unresolved, "cancelled");
			task.observation = structuredClone(transition.observation);
			if (transition.type === "resume") task.status = "active";
			recordOriginStep(task, transition.observation);
			break;
		}
		case "extend-origin": {
			if (task.authorization.state !== "active")
				reject("Task authorization is revoked", "TASK_REVOKED");
			if (unresolved && ["dispatched", "unknown"].includes(unresolved.status))
				reject(
					"Resolve the previous operation before changing scope",
					"TASK_UNKNOWN_OUTCOME",
				);
			if (typeof transition.origin !== "string") reject("Invalid task origin");
			origin(transition.origin);
			id(transition.checkRef);
			if (task.allowedOrigins.includes(transition.origin))
				reject("Origin is already in task scope");
			if ((task.originGrants?.length ?? 0) >= MAX_TASK_ORIGIN_GRANTS)
				reject("Too many origin grants for one task", "TASK_ORIGIN_LIMIT");
			if (unresolved?.status === "prepared")
				setStatus(task, unresolved, "cancelled");
			if (!task.originGrants || !task.originChain) {
				// The chain starts where the person already is.
				task.originChain = task.observation
					? [
							{
								origin: task.observation.origin,
								epoch: task.epoch,
								at: task.observation.observedAt,
							},
						]
					: [];
				task.originGrants = [];
			}
			// Nothing observed or prepared under the narrower scope can act under
			// this one: like a reconciled readback, the next action needs a fresh look.
			task.epoch++;
			task.observation = null;
			task.originGrants.push({
				origin: transition.origin,
				checkRef: transition.checkRef,
				epoch: task.epoch,
				grantedAt: now,
				retractedAt: null,
			});
			task.allowedOrigins.push(transition.origin);
			break;
		}
		case "retract-origin": {
			const grant = task.originGrants?.find(
				(item) =>
					item.origin === transition.origin && item.retractedAt === null,
			);
			if (!grant) reject("Origin was not granted to this task");
			task.epoch++;
			if (unresolved?.status === "prepared")
				setStatus(task, unresolved, "cancelled");
			else if (unresolved?.status === "dispatched") {
				// Same fence as pause: the effect may have run under the old scope.
				setStatus(task, unresolved, "unknown");
				task.status = "paused";
			}
			grant.retractedAt = now;
			task.allowedOrigins = task.allowedOrigins.filter(
				(item) => item !== transition.origin,
			);
			task.observation = null;
			break;
		}
		case "rebind": {
			if (task.status !== "active" || task.authorization.state !== "active")
				reject("Only an active task can take a new binding", "TASK_NOT_ACTIVE");
			if (unresolved && ["dispatched", "unknown"].includes(unresolved.status))
				reject(
					"Resolve the previous operation before a new binding",
					"TASK_UNKNOWN_OUTCOME",
				);
			if (unresolved?.status === "prepared") unresolved.status = "cancelled";
			task.epoch++;
			task.observation = null;
			break;
		}
		case "pause":
		case "cancel":
		case "recover":
		case "revoke": {
			task.epoch++;
			if (unresolved?.status === "prepared")
				setStatus(task, unresolved, "cancelled");
			else if (unresolved?.status === "dispatched")
				setStatus(task, unresolved, "unknown");
			if (transition.type === "revoke") {
				task.authorization.state = "revoked";
				task.authorization.revokedAt = new Date(now).toISOString();
			}
			if (!terminal)
				task.status = transition.type === "cancel" ? "cancelled" : "paused";
			break;
		}
		case "prepare": {
			validateProposal(transition.proposal);
			checkDispatch(task, transition.proposal, now);
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
			checkDispatch(task, unresolved.proposal, now);
			setStatus(task, unresolved, "dispatched");
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
			replaceOperation(
				task,
				operation,
				transition.status === "unknown"
					? {
							proposal: operation.proposal,
							status: "unknown",
							...(transition.evidenceRef !== undefined && {
								evidenceRef: transition.evidenceRef,
							}),
						}
					: {
							proposal: operation.proposal,
							status: transition.status,
							evidenceRef: transition.evidenceRef,
						},
			);
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
			unknownTransition(transition);
	}
	task.revision++;
	task.updatedAt = now;
	validateInteractiveTask(task);
	const operationId =
		transition.type === "prepare"
			? transition.proposal.id
			: "operationId" in transition
				? transition.operationId
				: undefined;
	// Per-origin audit for extended tasks; single-origin events are unchanged.
	const eventOrigin =
		transition.type === "extend-origin" || transition.type === "retract-origin"
			? transition.origin
			: task.originGrants &&
					(transition.type === "observe" || transition.type === "resume")
				? transition.observation.origin
				: undefined;
	const event: unknown = {
		eventId: `${task.id}#${task.revision}`,
		schemaVersion: 1,
		taskId: task.id,
		sequence: task.revision,
		epoch: task.epoch,
		kind: transition.type,
		at: now,
		status: task.status,
		...(operationId !== undefined && {
			operationId,
			operationStatus: task.operations.find(
				(operation) => operation.proposal.id === operationId,
			)?.status,
		}),
		...(eventOrigin !== undefined && { origin: eventOrigin }),
	};
	validateTaskEvent(event);
	return { task, event };
}
