/**
 * Minimal stack-backed context manager for environments without AsyncLocalStorage.
 *
 * This only preserves context for synchronous nested calls. Node paths should
 * prefer AsyncLocalStorage when async propagation is required.
 */
export class StackContextManager<TContext> {
	private stack: TContext[] = [];

	run<T>(context: TContext, fn: () => T): T {
		this.stack.push(context);
		try {
			return fn();
		} finally {
			this.stack.pop();
		}
	}

	active(): TContext | undefined {
		return this.stack.length > 0
			? this.stack[this.stack.length - 1]
			: undefined;
	}
}
