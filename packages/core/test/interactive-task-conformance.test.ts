/**
 * Exhaustive both-directions conformance of transitionInteractiveTask with an
 * abstract spec. The spec is an abstract state, an event alphabet with
 * relative arguments (fresh or stale views, bad proposals, owner, revision and
 * clock probes) and a successor function that returns null for "must refuse".
 * A breadth-first search over the spec graph drives the real reducer from a
 * representative task per spec state and tries every event in every state.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	createInteractiveTask,
	type InteractiveTask,
	type TaskActionProposal,
	type TaskContext,
	type TaskEvent,
	type TaskOperationStatus,
	type TaskStatus,
	type TaskTransition,
	transitionInteractiveTask,
} from "../src/messaging/interactive-task";

type OpState = TaskOperationStatus | "none";
type Op = "op1" | "op2";
interface State {
	status: TaskStatus;
	auth: "active" | "revoked";
	obs: null | "A" | "B";
	op1: OpState;
	op2: OpState;
	/** B is in allowedOrigins through an active grant. */
	scopeB: boolean;
	/** The task carries originGrants. */
	extended: boolean;
}
const BAD_PREPARE = [
	"staleEpoch",
	"staleObs",
	"otherObsId",
	"staleInput",
	"wrongAuth",
	"badCap",
	"expired",
	"wrongTask",
] as const;
type Inner = "pause" | "prepare" | "dispatch" | "observe";
type Event =
	| { k: "observe" | "resume"; origin: "A" | "B"; stale: boolean }
	| {
			k:
				| "pause"
				| "cancel"
				| "recover"
				| "revoke"
				| "complete"
				| "extend"
				| "retract";
	  }
	| { k: "prepare"; op: Op; bad: (typeof BAD_PREPARE)[number] | null }
	| { k: "dispatch"; op: Op }
	| {
			k: "result" | "reconcile";
			op: Op;
			st: "succeeded" | "failed" | "unknown";
	  }
	| {
			k: "ctx";
			probe:
				| "staleRevision"
				| "wrongOwner"
				| "clockBack"
				| "sameClock"
				| "expiredAtDispatch";
			inner: Inner;
	  };

const OPS: Op[] = ["op1", "op2"];
const ALPHABET: Event[] = (() => {
	const all: Event[] = [];
	for (const k of ["observe", "resume"] as const) {
		for (const origin of ["A", "B"] as const)
			all.push({ k, origin, stale: false });
		all.push({ k, origin: "A", stale: true });
	}
	for (const k of [
		"pause",
		"cancel",
		"recover",
		"revoke",
		"complete",
		"extend",
		"retract",
	] as const)
		all.push({ k });
	for (const op of OPS) {
		all.push({ k: "prepare", op, bad: null });
		for (const bad of BAD_PREPARE) all.push({ k: "prepare", op, bad });
		all.push({ k: "dispatch", op });
		for (const k of ["result", "reconcile"] as const)
			for (const st of ["succeeded", "failed", "unknown"] as const)
				all.push({ k, op, st });
	}
	for (const probe of ["staleRevision", "wrongOwner", "clockBack"] as const)
		for (const inner of ["pause", "prepare", "dispatch", "observe"] as const)
			all.push({ k: "ctx", probe, inner });
	all.push({ k: "ctx", probe: "sameClock", inner: "pause" });
	all.push({ k: "ctx", probe: "expiredAtDispatch", inner: "dispatch" });
	return all;
})();
const name = (e: Event) => JSON.stringify(e);
const key = (s: State) =>
	`${s.status}|${s.auth}|${s.obs}|${s.op1}|${s.op2}|${s.scopeB}|${s.extended}`;

const isUnresolved = (state: OpState) =>
	state === "prepared" || state === "dispatched" || state === "unknown";
const unresolved = (s: State): Op | null =>
	isUnresolved(s.op1) ? "op1" : isUnresolved(s.op2) ? "op2" : null;
const ended = (s: State) =>
	s.status === "completed" || s.status === "cancelled";
/** The plain event a context probe wraps, chosen the same way the driver does. */
function innerEvent(s: State, inner: Inner): Event {
	if (inner === "pause") return { k: "pause" };
	if (inner === "observe") return { k: "observe", origin: "A", stale: false };
	if (inner === "prepare")
		return { k: "prepare", op: s.op1 === "none" ? "op1" : "op2", bad: null };
	return { k: "dispatch", op: s.op2 === "prepared" ? "op2" : "op1" };
}

/** The successor and whether the epoch advances, or null when the reducer must refuse. */
function step(previous: State, e: Event): { s: State; bump: boolean } | null {
	const s: State = { ...previous };
	const u = unresolved(s);
	if (e.k === "ctx") {
		// A clock behind the task's time, or equal to it, changes nothing: time
		// is clamped to updatedAt. Owner, revision and expiry gates refuse.
		if (e.probe === "clockBack" || e.probe === "sameClock")
			return step(previous, innerEvent(previous, e.inner));
		return null;
	}
	if (ended(s) && !["reconcile", "recover", "revoke", "retract"].includes(e.k))
		return null;
	const cancelPrepared = () => {
		if (u && s[u] === "prepared") s[u] = "cancelled";
	};
	switch (e.k) {
		case "observe":
		case "resume":
			if (s.auth !== "active") return null;
			if (e.k === "resume" && s.status !== "paused") return null;
			if (u && s[u] !== "prepared") return null;
			if (e.origin === "B" && !s.scopeB) return null;
			if (e.stale && s.obs !== null) return null;
			cancelPrepared();
			s.obs = e.origin;
			if (e.k === "resume") s.status = "active";
			return { s, bump: false };
		case "extend":
			if (s.auth !== "active" || (u && s[u] !== "prepared") || s.scopeB)
				return null;
			cancelPrepared();
			Object.assign(s, { obs: null, scopeB: true, extended: true });
			return { s, bump: true };
		case "retract":
			if (!s.scopeB) return null;
			if (u && s[u] === "dispatched") {
				s[u] = "unknown";
				s.status = "paused";
			}
			cancelPrepared();
			Object.assign(s, { obs: null, scopeB: false });
			return { s, bump: true };
		case "pause":
		case "cancel":
		case "recover":
		case "revoke": {
			const wasEnded = ended(s);
			if (u && s[u] === "dispatched") s[u] = "unknown";
			cancelPrepared();
			if (e.k === "revoke") s.auth = "revoked";
			if (!wasEnded) s.status = e.k === "cancel" ? "cancelled" : "paused";
			return { s, bump: true };
		}
		case "prepare":
			if (e.bad || s.status !== "active" || s.auth !== "active") return null;
			if (s.obs === null || u || s[e.op] !== "none") return null;
			s[e.op] = "prepared";
			return { s, bump: false };
		case "dispatch":
			if (u !== e.op || s[e.op] !== "prepared") return null;
			s[e.op] = "dispatched";
			s.status = "waiting";
			return { s, bump: false };
		case "result":
			if (s[e.op] !== "dispatched") return null;
			s[e.op] = e.st;
			if (s.status === "waiting")
				s.status = e.st === "unknown" ? "blocked" : "active";
			return { s, bump: false };
		case "reconcile": {
			if (s[e.op] !== "unknown") return null;
			s[e.op] = e.st;
			const resolved = e.st !== "unknown";
			if (resolved) s.obs = null;
			if (resolved && s.status === "blocked") s.status = "paused";
			return { s, bump: resolved };
		}
		case "complete":
			if (u) return null;
			s.status = "completed";
			return { s, bump: true };
	}
}

const A = "https://a.example";
const B = "https://b.example";
const owner = {
	actorId: "actor",
	agentId: "agent",
	connector: { source: "browser", accountId: "account" },
};

function abstract(t: InteractiveTask): State {
	const op = (id: Op) =>
		t.operations.find((o) => o.proposal.id === id)?.status ?? "none";
	return {
		status: t.status,
		auth: t.authorization.state,
		obs: t.observation ? (t.observation.origin === A ? "A" : "B") : null,
		op1: op("op1"),
		op2: op("op2"),
		scopeB: t.allowedOrigins.includes(B),
		extended: t.originGrants !== undefined,
	};
}
function proposal(
	t: InteractiveTask,
	id: Op,
	now: number,
	bad: (typeof BAD_PREPARE)[number] | null,
): TaskActionProposal {
	const version = t.observation?.version ?? 0;
	return {
		id,
		taskId: bad === "wrongTask" ? "task-2" : t.id,
		epoch: bad === "staleEpoch" ? (t.epoch > 0 ? t.epoch - 1 : 1) : t.epoch,
		observationId:
			bad === "otherObsId" ? "view-other" : (t.observation?.id ?? "none"),
		observationVersion:
			bad === "staleObs" ? (version > 0 ? version - 1 : 1) : version,
		inputRevision:
			(t.observation?.inputRevision ?? 0) + (bad === "staleInput" ? 1 : 0),
		targetRef: "button",
		capability: bad === "badCap" ? "type" : "click",
		authorizationId: bad === "wrongAuth" ? "other" : "grant",
		expiresAt: bad === "expired" ? now : now + 1e9,
	};
}
function concrete(
	t: InteractiveTask,
	s: State,
	e: Event,
): { context: TaskContext; transition: TaskTransition } {
	const context = { owner, expectedRevision: t.revision, now: t.updatedAt + 1 };
	let plain = e;
	if (e.k === "ctx") {
		if (e.probe === "staleRevision") context.expectedRevision = t.revision + 1;
		if (e.probe === "wrongOwner")
			context.owner = { ...owner, actorId: "someone-else" };
		if (e.probe === "clockBack") context.now = t.updatedAt - 1;
		if (e.probe === "sameClock") context.now = t.updatedAt;
		const prepared = t.operations.find((o) => o.status === "prepared");
		if (e.probe === "expiredAtDispatch" && prepared)
			context.now = prepared.proposal.expiresAt;
		plain = innerEvent(s, e.inner);
	}
	const now = context.now;
	switch (plain.k) {
		case "observe":
		case "resume": {
			const previous = t.observation?.version ?? 0;
			const version = plain.stale ? previous : previous + 1;
			return {
				context,
				transition: {
					type: plain.k,
					observation: {
						id: `view-${version}`,
						pageId: "page",
						origin: plain.origin === "A" ? A : B,
						version,
						inputRevision: 0,
						observedAt: now,
					},
				},
			};
		}
		case "extend":
			return {
				context,
				transition: { type: "extend-origin", origin: B, checkRef: "check" },
			};
		case "retract":
			return { context, transition: { type: "retract-origin", origin: B } };
		case "prepare":
			return {
				context,
				transition: {
					type: "prepare",
					proposal: proposal(t, plain.op, now, plain.bad),
				},
			};
		case "dispatch":
			return {
				context,
				transition: { type: "dispatch", operationId: plain.op },
			};
		case "result":
		case "reconcile":
			return {
				context,
				transition:
					plain.st === "unknown"
						? { type: plain.k, operationId: plain.op, status: "unknown" }
						: {
								type: plain.k,
								operationId: plain.op,
								status: plain.st,
								evidenceRef: "evidence",
							},
			};
		case "ctx":
			throw new Error("probes wrap a plain event");
		default:
			return { context, transition: { type: plain.k } };
	}
}
function deepFreeze<T>(value: T): T {
	if (value && typeof value === "object" && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const item of Object.values(value)) deepFreeze(item);
	}
	return value;
}

describe("interactive task reducer conformance", () => {
	it("accepts exactly the spec's transitions, with its successors, in every state", () => {
		const init = createInteractiveTask({
			id: "task-1",
			owner,
			goalRef: "goal",
			now: 1000,
			authorization: {
				decisionId: "grant",
				policyRevision: "policy",
				decidedAt: new Date(1000).toISOString(),
				state: "active",
				revokedAt: null,
			},
			allowedCapabilities: ["click"],
			allowedOrigins: [A],
		});
		const start = abstract(init);
		const tasks = new Map([[key(start), deepFreeze(init)]]);
		const states = new Map([[key(start), start]]);
		const queue = [start];
		let edges = 0;
		const failures: string[] = [];
		const check = (
			previous: InteractiveTask,
			got: { task: InteractiveTask; event: TaskEvent },
			bump: boolean,
		) => {
			const { task, event } = got;
			if (task.revision !== previous.revision + 1) return "revision";
			if (task.epoch - previous.epoch !== (bump ? 1 : 0)) return "epoch";
			if (task.updatedAt < previous.updatedAt) return "time moved back";
			if (event.at !== task.updatedAt) return "event time";
			if (
				event.sequence !== task.revision ||
				event.epoch !== task.epoch ||
				event.status !== task.status
			)
				return "event";
			return null;
		};
		while (queue.length) {
			const s = queue.shift() as State;
			const task = tasks.get(key(s)) as InteractiveTask;
			for (const e of ALPHABET) {
				const want = step(s, e);
				const { context, transition } = concrete(task, s, e);
				let got: { task: InteractiveTask; event: TaskEvent } | undefined;
				try {
					// Frozen inputs: the reducer must never write to what it was given.
					got = transitionInteractiveTask(
						task,
						deepFreeze(context),
						deepFreeze(transition),
					);
				} catch (error) {
					if (want)
						failures.push(
							`refused ${key(s)} ${name(e)}: ${(error as Error).message}`,
						);
					continue;
				}
				if (!want) {
					failures.push(`accepted ${key(s)} ${name(e)}`);
					continue;
				}
				edges++;
				const wrong =
					key(abstract(got.task)) !== key(want.s)
						? "state"
						: check(task, got, want.bump);
				if (wrong) {
					failures.push(`${wrong}: ${key(s)} ${name(e)}`);
					continue;
				}
				const next = key(want.s);
				if (!states.has(next)) {
					states.set(next, want.s);
					tasks.set(next, deepFreeze(got.task));
					queue.push(want.s);
				}
			}
		}
		expect(failures.slice(0, 10)).toEqual([]);
		// Pinned so that a weaker spec or a smaller alphabet fails review.
		expect({ states: states.size, edges, alphabet: ALPHABET.length }).toEqual({
			states: 1015,
			edges: 6603,
			alphabet: 59,
		});
		// About 12 s under bun and 40 s under vitest on an idle machine; the
		// default timeouts are far shorter, and a loaded CI host is slower still.
	}, 180_000);

	it("has the reachable graph of tla/InteractiveTask.tla, which TLC checks", () => {
		// The TLA+ module is the model of record: scripts/check-tla.ts writes its
		// TLC state graph to this file and model-checks the stored invariants.
		const tla = JSON.parse(
			readFileSync(
				new URL("../tla/InteractiveTask.reducer.graph.json", import.meta.url),
				"utf8",
			),
		) as { states: unknown[]; initial: number[]; next: number[][] };
		const asTla = (s: State) =>
			JSON.stringify({
				auth: s.auth,
				extended: s.extended,
				obs: s.obs ?? "none",
				op: { op1: s.op1, op2: s.op2 },
				scopeB: s.scopeB,
				status: s.status,
			});
		const index = new Map(tla.states.map((s, i) => [JSON.stringify(s), i]));
		const start: State = {
			status: "active",
			auth: "active",
			obs: null,
			op1: "none",
			op2: "none",
			scopeB: false,
			extended: false,
		};
		const successors = new Map<string, Set<string>>();
		const queue = [start];
		successors.set(asTla(start), new Set());
		while (queue.length) {
			const s = queue.shift() as State;
			const from = asTla(s);
			for (const e of ALPHABET) {
				const next = step(s, e)?.s;
				if (!next || asTla(next) === from) continue;
				successors.get(from)?.add(asTla(next));
				if (!successors.has(asTla(next))) {
					successors.set(asTla(next), new Set());
					queue.push(next);
				}
			}
		}
		expect(tla.initial.map((i) => JSON.stringify(tla.states[i]))).toEqual([
			asTla(start),
		]);
		expect([...successors.keys()].sort()).toEqual([...index.keys()].sort());
		for (const [from, to] of successors) {
			const expected = (tla.next[index.get(from) as number] ?? []).map((i) =>
				JSON.stringify(tla.states[i]),
			);
			expect([...to].sort(), from).toEqual(expected.sort());
		}
	});
});
