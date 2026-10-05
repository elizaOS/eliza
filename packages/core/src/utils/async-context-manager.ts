/** Async scopes for the supported Node runtime. */
import { AsyncLocalStorage } from "node:async_hooks";

export class AsyncContextManager<TContext> {
	private readonly storage = new AsyncLocalStorage<TContext>();
	run<T>(context: TContext, fn: () => T): T {
		return this.storage.run(context, fn);
	}
	active(): TContext | undefined {
		return this.storage.getStore();
	}
}
