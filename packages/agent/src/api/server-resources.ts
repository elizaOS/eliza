/**
 * Awaits server-side resource teardown in reverse registration order. A failed
 * disposer is reported and the remaining resources still close, so shutdown is
 * complete and observable instead of spawning detached cleanup promises.
 */

export interface ServerResource {
  readonly name: string;
  dispose(): void | Promise<void>;
}

export interface ServerResources {
  add(resource: ServerResource): void;
  close(): Promise<void>;
}

export function createServerResources(
  reportFailure: (resource: string, error: unknown) => void,
): ServerResources {
  const resources: ServerResource[] = [];
  let closePromise: Promise<void> | null = null;
  return {
    add(resource) {
      if (closePromise) {
        throw new Error(
          `Cannot register ${resource.name} after server teardown`,
        );
      }
      resources.push(resource);
    },
    close() {
      closePromise ??= closeServerResources(resources, reportFailure);
      return closePromise;
    },
  };
}

export async function closeServerResources(
  resources: readonly ServerResource[],
  reportError: (resource: string, error: unknown) => void,
): Promise<void> {
  for (const resource of [...resources].reverse()) {
    try {
      await resource.dispose();
    } catch (error) {
      reportError(resource.name, error);
    }
  }
}
