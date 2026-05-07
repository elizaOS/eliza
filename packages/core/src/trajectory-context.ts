/**
 * Trajectory context management for benchmark/training traces.
 *
 * Node.js: AsyncLocalStorage for async-safe propagation (initialized
 * synchronously to avoid race with first message processing).
 * Browser: stack-based fallback.
 */
import { StackContextManager } from "./utils/stack-context-manager";

export interface TrajectoryContext {
	/** Active trajectory identifier, when the logger separates trajectory and step ids. */
	trajectoryId?: string;
	trajectoryStepId?: string;
	/** Current runtime run identifier associated with the active trajectory step. */
	runId?: string;
	/** Room context for pipeline/model hooks emitted during trajectory logging. */
	roomId?: string;
	/** Source message identifier associated with the active trajectory context. */
	messageId?: string;
	/** Pipeline stage purpose for trajectory logging (e.g. "should_respond", "response", "action", "evaluation"). */
	purpose?: string;
	/**
	 * Step ID of the parent trajectory step, when the current step was
	 * dispatched from inside another (e.g. an action invoked through
	 * `executeCode`). Persistence layers use this to attach child step IDs
	 * to the parent's `childSteps` array.
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
let globalContextManager: ITrajectoryContextManager | null = null;
const TRAJECTORY_CONTEXT_MANAGER_KEY = Symbol.for(
	"elizaos.trajectoryContextManager",
);

type GlobalWithTrajectoryContextManager = typeof globalThis & {
	[TRAJECTORY_CONTEXT_MANAGER_KEY]?: ITrajectoryContextManager;
};

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
	if (!globalContextManager) {
		const globalManager = (globalThis as GlobalWithTrajectoryContextManager)[
			TRAJECTORY_CONTEXT_MANAGER_KEY
		];
		if (globalManager) {
			globalContextManager = globalManager;
		} else {
			globalContextManager = initContextManagerSync();
			(globalThis as GlobalWithTrajectoryContextManager)[
				TRAJECTORY_CONTEXT_MANAGER_KEY
			] = globalContextManager;
		}
	}
	return globalContextManager;
}

export function setTrajectoryContextManager(
	manager: ITrajectoryContextManager,
): void {
	globalContextManager = manager;
	(globalThis as GlobalWithTrajectoryContextManager)[
		TRAJECTORY_CONTEXT_MANAGER_KEY
	] = manager;
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
 * Set the pipeline purpose on the current trajectory context.
 * Mutates in place so nested useModel calls pick up the correct stage.
 */
export function setTrajectoryPurpose(purpose: string): void {
	const ctx = getOrCreateContextManager().active();
	if (ctx) ctx.purpose = purpose;
}
