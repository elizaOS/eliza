/**
 * The storage boundary admits exactly the task fence invariant. Every abstract
 * document in a small domain, reachable or not, becomes a real task record:
 * validateInteractiveTask must accept exactly the documents the invariant
 * allows, and on each one the reducer must enable exactly the model's
 * transitions with the model's successor, so the stricter check never refuses
 * a transition that the invariant allows.
 */
import { describe, expect, it } from "vitest";
import {
	type InteractiveTask,
	type TaskActionProposal,
	type TaskOperationStatus,
	type TaskStatus,
	type TaskTransition,
	transitionInteractiveTask,
	validateInteractiveTask,
} from "../src/messaging/interactive-task";

type OpState = TaskOperationStatus | "none";
type OpName = "a" | "b";
interface Doc {
	status: TaskStatus;
	auth: "active" | "revoked";
	epoch: number;
	/** 0 is no observation; otherwise the observed version (and id). */
	obs: number;
	ops: Record<OpName, { state: OpState; epoch: number; version: number }>;
}

const OPS: OpName[] = ["a", "b"];
const STATUSES: TaskStatus[] = [
	"active",
	"paused",
	"blocked",
	"waiting",
	"completed",
	"cancelled",
];
const OP_STATES: OpState[] = [
	"none",
	"prepared",
	"dispatched",
	"succeeded",
	"failed",
	"cancelled",
	"unknown",
];
// Two epochs already give an operation that is behind, level with and ahead
// of its task; a third only multiplies the run time.
const EPOCHS = [0, 1];
const OBSERVED = [0, 1, 2];
const OFFERED = [1, 2, 3];
const A = "https://a.example";
const B = "https://b.example";
const owner = {
	actorId: "actor",
	agentId: "agent",
	connector: { source: "grace", accountId: "account" },
};

const unresolved = (state: OpState) =>
	state === "prepared" || state === "dispatched" || state === "unknown";
const ended = (doc: Doc) =>
	doc.status === "completed" || doc.status === "cancelled";

/** The proved invariant: the document shape plus the fence (Fresh). */
function invariant(doc: Doc): boolean {
	const states = OPS.map((op) => doc.ops[op].state);
	if (states.filter(unresolved).length > 1) return false;
	if ((doc.status === "waiting") !== states.includes("dispatched"))
		return false;
	if (states.includes("prepared") && doc.status !== "active") return false;
	if (
		states.includes("unknown") &&
		!["blocked", "paused", "cancelled"].includes(doc.status)
	)
		return false;
	if (doc.status === "blocked" && !states.includes("unknown")) return false;
	if (doc.auth === "revoked" && ["active", "waiting"].includes(doc.status))
		return false;
	return OPS.every((id) => {
		const op = doc.ops[id];
		if (op.epoch > doc.epoch) return false;
		// Only a prepared operation is fenced; a dispatched one may already have
		// had its effect, so it must load and recover to unknown.
		if (op.state !== "prepared") return true;
		return (
			doc.obs !== 0 &&
			op.epoch === doc.epoch &&
			op.version === doc.obs &&
			doc.auth === "active"
		);
	});
}

function proposal(id: string, epoch: number, version: number) {
	return {
		id,
		taskId: "task-1",
		epoch,
		observationId: `obs-${version}`,
		observationVersion: version,
		inputRevision: 0,
		targetRef: "button",
		capability: "click",
		authorizationId: "decision-1",
		expiresAt: 1e9,
	} satisfies TaskActionProposal;
}

function concrete(doc: Doc): InteractiveTask {
	const task = {
		schemaVersion: 1,
		id: "task-1",
		owner: structuredClone(owner),
		goalRef: "goal",
		revision: 7,
		epoch: doc.epoch,
		status: doc.status,
		authorization: {
			decisionId: "decision-1",
			policyRevision: "policy-1",
			decidedAt: new Date(0).toISOString(),
			state: doc.auth,
			revokedAt: doc.auth === "revoked" ? new Date(5).toISOString() : null,
		},
		allowedCapabilities: ["click"],
		allowedOrigins: [A, B],
		observation:
			doc.obs === 0
				? null
				: {
						id: `obs-${doc.obs}`,
						pageId: "page",
						origin: A,
						version: doc.obs,
						inputRevision: 0,
						observedAt: 50,
					},
		operations: [] as unknown[],
		updatedAt: 100,
		originGrants: [
			{
				origin: B,
				checkRef: "check",
				epoch: 0,
				grantedAt: 10,
				retractedAt: null,
			},
		],
		originChain: [],
	};
	for (const id of OPS) {
		const { state, epoch, version } = doc.ops[id];
		if (state === "none") continue;
		task.operations.push({
			proposal: proposal(id, epoch, version),
			status: state,
			...((state === "succeeded" || state === "failed") && {
				evidenceRef: "evidence",
			}),
		});
	}
	return task as InteractiveTask;
}

function abstract(task: InteractiveTask): string {
	return JSON.stringify([
		task.status,
		task.authorization.state,
		task.epoch,
		task.observation?.version ?? 0,
		OPS.map((id) => {
			const op = task.operations.find((item) => item.proposal.id === id);
			return op
				? [op.status, op.proposal.epoch, op.proposal.observationVersion]
				: ["none", 0, 0];
		}),
	]);
}
const key = (doc: Doc) =>
	JSON.stringify([
		doc.status,
		doc.auth,
		doc.epoch,
		doc.obs,
		OPS.map((id) => {
			const op = doc.ops[id];
			return op.state === "none"
				? ["none", 0, 0]
				: [op.state, op.epoch, op.version];
		}),
	]);

/** The model's successor (TaskFenceProof, without ghosts), or null when disabled. */
function model(doc: Doc, transition: TaskTransition): Doc | null {
	const next = structuredClone(doc);
	const each = (change: (op: Doc["ops"][OpName]) => void) => {
		for (const id of OPS) change(next.ops[id]);
	};
	const cancelPrepared = () =>
		each((op) => {
			if (op.state === "prepared") op.state = "cancelled";
		});
	const fence = () =>
		each((op) => {
			if (op.state === "prepared") op.state = "cancelled";
			else if (op.state === "dispatched") op.state = "unknown";
		});
	const inFlight = OPS.some((id) =>
		["dispatched", "unknown"].includes(doc.ops[id].state),
	);
	switch (transition.type) {
		case "observe":
		case "resume": {
			const version = transition.observation.version;
			if (ended(doc) || doc.auth !== "active" || inFlight) return null;
			if (doc.obs !== 0 && version <= doc.obs) return null;
			if (transition.type === "resume" && doc.status !== "paused") return null;
			cancelPrepared();
			next.obs = version;
			if (transition.type === "resume") next.status = "active";
			return next;
		}
		case "extend-origin":
			if (ended(doc) || doc.auth !== "active" || inFlight) return null;
			cancelPrepared();
			next.epoch++;
			next.obs = 0;
			return next;
		case "retract-origin":
			if (OPS.some((id) => doc.ops[id].state === "dispatched"))
				next.status = "paused";
			fence();
			next.epoch++;
			next.obs = 0;
			return next;
		case "pause":
		case "cancel":
		case "recover":
		case "revoke":
			if (["pause", "cancel"].includes(transition.type) && ended(doc))
				return null;
			fence();
			next.epoch++;
			if (transition.type === "revoke") next.auth = "revoked";
			if (!ended(doc))
				next.status = transition.type === "cancel" ? "cancelled" : "paused";
			return next;
		case "prepare": {
			const { id, epoch, observationVersion } = transition.proposal;
			const op = next.ops[id as OpName];
			if (doc.status !== "active" || doc.auth !== "active") return null;
			if (doc.obs === 0 || epoch !== doc.epoch) return null;
			if (observationVersion !== doc.obs) return null;
			if (OPS.some((name) => unresolved(doc.ops[name].state))) return null;
			if (op.state !== "none") return null;
			Object.assign(op, {
				state: "prepared",
				epoch,
				version: observationVersion,
			});
			return next;
		}
		case "dispatch": {
			const op = next.ops[transition.operationId as OpName];
			if (ended(doc) || op.state !== "prepared") return null;
			op.state = "dispatched";
			next.status = "waiting";
			return next;
		}
		case "result": {
			const op = next.ops[transition.operationId as OpName];
			if (ended(doc) || op.state !== "dispatched") return null;
			op.state = transition.status;
			if (doc.status === "waiting")
				next.status = transition.status === "unknown" ? "blocked" : "active";
			return next;
		}
		case "reconcile": {
			const op = next.ops[transition.operationId as OpName];
			if (op.state !== "unknown") return null;
			op.state = transition.status;
			if (transition.status !== "unknown") {
				next.epoch++;
				next.obs = 0;
				if (doc.status === "blocked") next.status = "paused";
			}
			return next;
		}
		case "complete":
			if (ended(doc) || OPS.some((id) => unresolved(doc.ops[id].state)))
				return null;
			next.status = "completed";
			next.epoch++;
			return next;
	}
}

function transitions(): TaskTransition[] {
	const all: TaskTransition[] = [];
	for (const version of OFFERED)
		for (const type of ["observe", "resume"] as const)
			all.push({
				type,
				observation: {
					id: `obs-${version}`,
					pageId: "page",
					origin: A,
					version,
					inputRevision: 0,
					observedAt: 60,
				},
			});
	all.push(
		{ type: "extend-origin", origin: "https://c.example", checkRef: "check-2" },
		{ type: "retract-origin", origin: B },
	);
	for (const type of [
		"pause",
		"cancel",
		"recover",
		"revoke",
		"complete",
	] as const)
		all.push({ type });
	for (const id of OPS) {
		for (const epoch of EPOCHS)
			for (const version of OFFERED)
				all.push({ type: "prepare", proposal: proposal(id, epoch, version) });
		all.push({ type: "dispatch", operationId: id });
		for (const type of ["result", "reconcile"] as const) {
			all.push({ type, operationId: id, status: "unknown" });
			for (const status of ["succeeded", "failed"] as const)
				all.push({ type, operationId: id, status, evidenceRef: "evidence-2" });
		}
	}
	return all;
}

function* documents(): Generator<Doc> {
	const choices: Doc["ops"][OpName][] = [];
	for (const state of OP_STATES) {
		if (state === "none") choices.push({ state, epoch: 0, version: 0 });
		else
			for (const epoch of EPOCHS)
				for (const version of [1, 2]) choices.push({ state, epoch, version });
	}
	for (const status of STATUSES)
		for (const auth of ["active", "revoked"] as const)
			for (const epoch of EPOCHS)
				for (const obs of OBSERVED)
					for (const a of choices)
						for (const b of choices)
							yield {
								status,
								auth,
								epoch,
								obs,
								ops: { a: { ...a }, b: { ...b } },
							};
}

const accepts = (task: InteractiveTask) => {
	try {
		validateInteractiveTask(task);
		return true;
	} catch {
		return false;
	}
};

describe("interactive task fence at the storage boundary", () => {
	it("validates exactly the fence invariant and preserves it on every transition", () => {
		const all = transitions();
		let documentCount = 0;
		let valid = 0;
		let accepted = 0;
		const disagreements: string[] = [];
		for (const doc of documents()) {
			documentCount++;
			const task = concrete(doc);
			const expected = invariant(doc);
			if (accepts(task) !== expected) {
				disagreements.push(`validate ${key(doc)}: expected ${expected}`);
				continue;
			}
			if (!expected) continue;
			valid++;
			for (const transition of all) {
				const want = model(doc, transition);
				let got: InteractiveTask | undefined;
				try {
					got = transitionInteractiveTask(
						task,
						{ owner, expectedRevision: 7, now: 1000 },
						transition,
					).task;
				} catch (error) {
					if (want)
						disagreements.push(
							`refused ${key(doc)} ${transition.type}: ${(error as Error).message}`,
						);
					continue;
				}
				accepted++;
				if (!want)
					disagreements.push(`accepted ${key(doc)} ${transition.type}`);
				else if (abstract(got) !== key(want))
					disagreements.push(`successor ${key(doc)} ${transition.type}`);
			}
		}
		expect(disagreements.slice(0, 10)).toEqual([]);
		// Pinned so a narrower domain or a weaker invariant fails review. Without
		// the fence check in validation, 7,746 of these documents validate.
		expect({ documentCount, valid, accepted }).toEqual({
			documentCount: 45_000,
			valid: 7_430,
			accepted: 46_204,
		});
		// About 10 s under bun on an idle machine and 30 s at a load average of 30;
		// the generous limit keeps a loaded CI host from failing it on time alone.
	}, 180_000);

	it("refuses a stored prepared action planned against an older view", () => {
		const fresh: Doc = {
			status: "waiting",
			auth: "active",
			epoch: 1,
			obs: 2,
			ops: {
				a: { state: "dispatched", epoch: 1, version: 2 },
				b: { state: "none", epoch: 0, version: 0 },
			},
		};
		expect(accepts(concrete(fresh))).toBe(true);
		const prepared = concrete({
			...fresh,
			status: "active",
			ops: { ...fresh.ops, a: { state: "prepared", epoch: 1, version: 2 } },
		});
		expect(accepts(prepared)).toBe(true);
		for (const stale of [
			{ epoch: 0, version: 2 },
			{ epoch: 1, version: 1 },
		]) {
			const task = concrete({
				...fresh,
				status: "active",
				ops: { ...fresh.ops, a: { state: "prepared", ...stale } },
			});
			expect(() => validateInteractiveTask(task)).toThrow(
				"Pending operation no longer matches its task",
			);
			// A dispatched operation may already have had its effect, so the
			// same stale record still loads and recovers to unknown.
			const dispatched = concrete({
				...fresh,
				ops: { ...fresh.ops, a: { ...fresh.ops.a, ...stale } },
			});
			expect(accepts(dispatched)).toBe(true);
			const { task: recovered } = transitionInteractiveTask(
				dispatched,
				{ owner, expectedRevision: 7, now: 1000 },
				{ type: "recover" },
			);
			expect(recovered.operations[0].status).toBe("unknown");
		}
		const withoutView = structuredClone(prepared);
		withoutView.observation = null;
		expect(() => validateInteractiveTask(withoutView)).toThrow(
			"Pending operation no longer matches its task",
		);
		// The domain above keeps these fields fixed, so each is checked here: a
		// prepared operation is refused, a dispatched one still loads.
		const tampered: [string, (task: InteractiveTask) => void][] = [
			[
				"observationId",
				(task) => (task.operations[0].proposal.observationId = "obs-other"),
			],
			[
				"inputRevision",
				(task) => (task.operations[0].proposal.inputRevision = 1),
			],
			[
				"authorizationId",
				(task) => (task.operations[0].proposal.authorizationId = "decision-2"),
			],
			[
				"capability",
				(task) => (task.operations[0].proposal.capability = "type"),
			],
			[
				"task inputRevision",
				(task) => {
					if (task.observation) task.observation.inputRevision = 1;
				},
			],
			[
				"task decisionId",
				(task) => (task.authorization.decisionId = "decision-2"),
			],
			["task capabilities", (task) => (task.allowedCapabilities = ["type"])],
		];
		for (const [field, tamper] of tampered) {
			const task = structuredClone(prepared);
			tamper(task);
			expect(() => validateInteractiveTask(task), field).toThrow(
				"Pending operation no longer matches its task",
			);
			const dispatched = concrete(fresh);
			tamper(dispatched);
			expect(accepts(dispatched), `dispatched ${field}`).toBe(true);
		}
	});

	it("keeps evidence only on an operation that ran", () => {
		const waiting = concrete({
			status: "waiting",
			auth: "active",
			epoch: 0,
			obs: 1,
			ops: {
				a: { state: "dispatched", epoch: 0, version: 1 },
				b: { state: "none", epoch: 0, version: 0 },
			},
		});
		const { task } = transitionInteractiveTask(
			waiting,
			{ owner, expectedRevision: 7, now: 1000 },
			{ type: "result", operationId: "a", status: "unknown" },
		);
		expect(task.operations[0]).toEqual({
			proposal: waiting.operations[0].proposal,
			status: "unknown",
		});
		expect(Object.keys(task.operations[0])).toEqual(["proposal", "status"]);
		const cancelled = concrete({
			status: "active",
			auth: "active",
			epoch: 0,
			obs: 1,
			ops: {
				a: { state: "cancelled", epoch: 0, version: 1 },
				b: { state: "none", epoch: 0, version: 0 },
			},
		});
		Object.assign(cancelled.operations[0], { evidenceRef: "receipt" });
		expect(() => validateInteractiveTask(cancelled)).toThrow(
			"Operation has evidence before it ran",
		);
	});
});
