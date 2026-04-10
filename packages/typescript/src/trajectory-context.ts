/**
 * Trajectory context management for benchmark/training traces.
 *
 * Node.js: AsyncLocalStorage for async-safe propagation (initialized
 * synchronously to avoid race with first message processing).
 * Browser: stack-based fallback.
 */
export interface TrajectoryContext {
	trajectoryStepId?: string;
	/** Correlation ids for JSONL / joins (set by message handler when step id is active) */
	runId?: string;
	roomId?: string;
	messageId?: string;
}

export interface ITrajectoryContextManager {
	run<T>(
		context: TrajectoryContext | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T>;
	active(): TrajectoryContext | undefined;
}

class StackContextManager implements ITrajectoryContextManager {
	private stack: Array<TrajectoryContext | undefined> = [];

	run<T>(
		context: TrajectoryContext | undefined,
		fn: () => T | Promise<T>,
	): T | Promise<T> {
		this.stack.push(context);
		try {
			return fn();
		} finally {
			this.stack.pop();
		}
	}

	active(): TrajectoryContext | undefined {
		return this.stack.length > 0
			? this.stack[this.stack.length - 1]
			: undefined;
	}
}

// Initialize the context manager synchronously in Node.js so that
// AsyncLocalStorage is available before the first message is processed.
// The previous lazy async init (.then()) caused a race: the stack-based
// fallback was used for early messages, which doesn't propagate context
// through async/await — so logLlmCall never saw the trajectory step ID.
let globalContextManager: ITrajectoryContextManager | null = null;

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
	return new StackContextManager();
}

function getOrCreateContextManager(): ITrajectoryContextManager {
	if (!globalContextManager) {
		globalContextManager = initContextManagerSync();
	}
	return globalContextManager;
}

export function setTrajectoryContextManager(
	manager: ITrajectoryContextManager,
): void {
	globalContextManager = manager;
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
