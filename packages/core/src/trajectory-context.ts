/**
 * Trajectory context management for benchmark/training traces.
 *
 * Node.js: AsyncLocalStorage for async-safe propagation (initialized
 * synchronously to avoid race with first message processing).
 * Browser: stack-based fallback.
 */

import { getAmbientSingleton, setAmbientSingleton } from "./ambient-context";
import type { PseudonymSession } from "./security/pii-pseudonymizer";
import type { SecretSwapSession } from "./security/secret-swap";
import type { RoleGateRole } from "./types/contexts";
import { StackContextManager } from "./utils/stack-context-manager";

export interface TrajectoryContext {
	/** Active trajectory identifier, when the logger separates trajectory and step ids. */
	trajectoryId?: string;
	trajectoryStepId?: string;
	/**
	 * Root-turn correlation id (#13775). Minted at the message.ts turn boundary
	 * so DB persistence and sub-agent spawns downstream can read one shared
	 * `traceId` and stitch the file, DB, and orchestrator trace stores together.
	 */
	traceId?: string;
	/** Current runtime run identifier associated with the active trajectory step. */
	runId?: string;
	/** Room context for pipeline/model hooks emitted during trajectory logging. */
	roomId?: string;
	/** Source message identifier associated with the active trajectory context. */
	messageId?: string;
	/** Sender role resolved for the active message, used for prompt identity and role-aware logging. */
	userRole?: RoleGateRole;
	/** Pipeline stage purpose for trajectory logging (e.g. "should_respond", "response", "action", "evaluation"). */
	purpose?: string;
	/**
	 * Turn-scoped secret-swap session (#10469). Minted on the first `useModel`
	 * call of a turn when secret-swap is enabled, then reused by every subsequent
	 * model call so all share one nonce, and read at the action-execution boundary
	 * (`executePlannedToolCall`) to restore real secrets into handler args. Absent
	 * when secret-swap is disabled — the egress restore is then a no-op.
	 */
	secretSwapSession?: SecretSwapSession;
	/**
	 * Turn-scoped PII pseudonymization session (#10469 / #7007). Minted on the
	 * first `useModel` call of a turn when PII swap is enabled, then reused by
	 * every subsequent model call so a real entity maps to the same surrogate all
	 * turn, and read at the action-execution boundary (`executePlannedToolCall`)
	 * to restore real names/orgs/addresses into handler args and reply text.
	 * Absent when PII swap is disabled — the egress restore is then a no-op.
	 */
	piiSwapSession?: PseudonymSession;
	/**
	 * Step ID of the parent trajectory step, when the current step was
	 * dispatched from inside another. Persistence layers use this to attach
	 * child step IDs to the parent's `childSteps` array.
	 */
	parentStepId?: string;
}

export interface ITrajectoryContextManager {
	run<T>(
		context: TrajectoryContext | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T>;
	active(): TrajectoryContext | undefined;
}

// Initialize the context manager synchronously in Node.js so that
// AsyncLocalStorage is available before the first message is processed.
// The previous lazy async init (.then()) caused a race: the stack-based
// fallback was used for early messages, which doesn't propagate context
// through async/await — so logLlmCall never saw the trajectory step ID.
const TRAJECTORY_CONTEXT_MANAGER_KEY = Symbol.for(
	"elizaos.trajectoryContextManager",
);

function isNodeEnvironment(): boolean {
	return (
		typeof process !== "undefined" &&
		typeof process.versions !== "undefined" &&
		typeof process.versions.node !== "undefined"
	);
}

function initContextManagerSync(): ITrajectoryContextManager {
	if (isNodeEnvironment()) {
		try {
			// eslint-disable-next-line @typescript-eslint/no-require-imports
			const { AsyncLocalStorage } =
				require("node:async_hooks") as typeof import("node:async_hooks");
			const storage = new AsyncLocalStorage<TrajectoryContext | undefined>();
			return {
				run<T>(
					context: TrajectoryContext | undefined,
					fn: () => T | Promise<T>,
				): T | Promise<T> {
					return storage.run(context, fn);
				},
				active(): TrajectoryContext | undefined {
					return storage.getStore();
				},
			} as ITrajectoryContextManager;
		} catch {
			// AsyncLocalStorage unavailable — fall back to stack
		}
	}
	return new StackContextManager<TrajectoryContext | undefined>();
}

function getOrCreateContextManager(): ITrajectoryContextManager {
	// The shared global slot is the single source of truth (no module-local
	// cache): under a duplicated core bundle every copy must observe the same
	// manager, and `setTrajectoryContextManager` must be visible everywhere.
	return getAmbientSingleton(
		TRAJECTORY_CONTEXT_MANAGER_KEY,
		initContextManagerSync,
	);
}

export function setTrajectoryContextManager(
	manager: ITrajectoryContextManager,
): void {
	setAmbientSingleton(TRAJECTORY_CONTEXT_MANAGER_KEY, manager);
}

export function getTrajectoryContextManager(): ITrajectoryContextManager {
	return getOrCreateContextManager();
}

export function runWithTrajectoryContext<T>(
	context: TrajectoryContext | undefined,
	fn: () => T | Promise<T>,
): T | Promise<T> {
	return getOrCreateContextManager().run(context, fn);
}

export function getTrajectoryContext(): TrajectoryContext | undefined {
	return getOrCreateContextManager().active();
}

/**
 * Run `fn` with the ambient trajectory context preserved and only `purpose`
 * overridden.
 *
 * Passing a bare `{ purpose }` object to {@link runWithTrajectoryContext}
 * REPLACES the active context: `trajectoryStepId` is dropped, so the runtime
 * never records the nested `useModel` call (and the purpose tag is lost with
 * it), and the turn's secret-swap/PII sessions stop propagating. Use this
 * helper to tag a model call with a purpose while keeping the active
 * step/run/room identifiers and swap sessions intact.
 */
export function runWithTrajectoryPurpose<T>(
	purpose: string,
	fn: () => T | Promise<T>,
): T | Promise<T> {
	const manager = getOrCreateContextManager();
	return manager.run({ ...manager.active(), purpose }, fn);
}

/**
 * Set the pipeline purpose on the current trajectory context.
 * Mutates in place so nested useModel calls pick up the correct stage.
 */
export function setTrajectoryPurpose(purpose: string): void {
	const ctx = getOrCreateContextManager().active();
	if (ctx) ctx.purpose = purpose;
}
