/**
 * Loop protection for the runtime's ERROR_REPORTED emit. `reportError` emits
 * ERROR_REPORTED to registered handlers; a handler that itself calls
 * `reportError` after an await would otherwise emit again, run itself again,
 * and recurse until the process restarts. The guard answers, for each report,
 * whether emitting is safe.
 *
 * Where the context storage propagates across awaits (AsyncLocalStorage on
 * Node) every emit runs inside a scope that every handler continuation
 * inherits, so a report raised from a still-running handler is attributed
 * exactly and unrelated concurrent chains are never affected. Browser and
 * edge builds only have the synchronous stack storage, whose scope is gone by
 * the handler's first await, so there the guard falls back to the loop's own
 * signature: a report whose scope already has an ERROR_REPORTED emit in
 * flight is recorded by the caller but not emitted again. That coalesces a
 * same-scope repeat while the first report's handlers are still running and
 * leaves every other scope alone; it is the narrowest rule that still
 * terminates the loop without async context.
 */
import {
	type AsyncContextStorage,
	createAsyncContextStorage,
} from "../plugin-lifecycle";

/** Scope that an ERROR_REPORTED emit runs in, visible to its handlers. */
export interface ErrorReportEmitScope {
	readonly scope: string;
	/** Set once every handler of the emit has settled; a later report from a detached continuation is not nested. */
	settled: boolean;
}

export type ErrorReportAttribution =
	| { kind: "emit" }
	| { kind: "nested"; originatingScope: string }
	| { kind: "repeat-in-flight"; inFlight: number };

export class ErrorReportEmitGuard {
	private readonly inFlightByScope = new Map<string, number>();

	constructor(
		private readonly storage: AsyncContextStorage<ErrorReportEmitScope> = createAsyncContextStorage<ErrorReportEmitScope>(),
	) {}

	/** Whether nested reports are attributed exactly across awaits. */
	get attributesAcrossAwaits(): boolean {
		return this.storage.propagatesAcrossAwaits;
	}

	/** Number of ERROR_REPORTED emits for `scope` whose handlers have not all settled. */
	inFlightEmits(scope: string): number {
		return this.inFlightByScope.get(scope) ?? 0;
	}

	/**
	 * Classify a report for `scope` being raised right now. `nested` means the
	 * caller is (transitively) inside a handler of an emit that has not
	 * settled; `repeat-in-flight` is the fallback verdict, without async
	 * context, for a scope whose previous emit is still running its handlers.
	 */
	attribute(scope: string): ErrorReportAttribution {
		const originating = this.storage.getStore();
		if (originating && !originating.settled) {
			return { kind: "nested", originatingScope: originating.scope };
		}
		if (!this.storage.propagatesAcrossAwaits) {
			const inFlight = this.inFlightEmits(scope);
			if (inFlight > 0) return { kind: "repeat-in-flight", inFlight };
		}
		return { kind: "emit" };
	}

	/**
	 * Run one ERROR_REPORTED emit for `scope`. The scope is visible to every
	 * continuation of `run` where the storage propagates across awaits, and
	 * the in-flight count for `scope` is held until the promise settles.
	 */
	async emit(scope: string, run: () => Promise<void>): Promise<void> {
		const store: ErrorReportEmitScope = { scope, settled: false };
		this.inFlightByScope.set(scope, this.inFlightEmits(scope) + 1);
		try {
			await this.storage.run(store, run);
		} finally {
			store.settled = true;
			const remaining = this.inFlightEmits(scope) - 1;
			if (remaining > 0) this.inFlightByScope.set(scope, remaining);
			else this.inFlightByScope.delete(scope);
		}
	}
}
