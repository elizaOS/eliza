/**
 * Node.js-specific streaming context manager using AsyncLocalStorage.
 *
 * AsyncLocalStorage provides proper async context isolation, ensuring that
 * parallel message processing doesn't interfere with each other's streaming context.
 *
 * @see https://nodejs.org/api/async_context.html
 */
import { AsyncLocalStorage } from 'async_hooks';
import type { StreamingContext, IStreamingContextManager } from './streaming-context';

/**
 * AsyncLocalStorage-based context manager for Node.js.
 * Provides proper async context isolation across parallel async operations.
 */
export class AsyncLocalStorageContextManager implements IStreamingContextManager {
  private storage = new AsyncLocalStorage<StreamingContext | undefined>();

  run<T>(context: StreamingContext | undefined, fn: () => T): T {
    return this.storage.run(context, fn);
  }

  active(): StreamingContext | undefined {
    return this.storage.getStore();
  }
}

/**
 * Create and return a configured AsyncLocalStorage context manager.
 * Called by index.node.ts during initialization.
 */
export function createNodeStreamingContextManager(): IStreamingContextManager {
  return new AsyncLocalStorageContextManager();
}
