/**
 * Allocates process-local worker namespaces and rejects accidental concurrent
 * reuse so parallel test workers cannot share mutable synthetic state.
 */
const activeNamespaces = new Set<string>();

const namespacePattern = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,255}$/;

export class NamespaceInUseError extends Error {
  public constructor(namespace: string) {
    super(`Synthetic-world namespace is already active: ${namespace}`);
    this.name = "NamespaceInUseError";
  }
}

export interface NamespaceLease {
  readonly namespace: string;
  release(): void;
}

export function createWorkerNamespace(
  worldId: string,
  workerId: string,
  runId: string,
): string {
  const namespace = `${worldId}:${workerId}:${runId}`;
  if (!namespacePattern.test(namespace)) {
    throw new RangeError(
      "Synthetic-world namespace contains unsupported characters or is too long",
    );
  }
  return namespace;
}

export function acquireNamespace(namespace: string): NamespaceLease {
  if (!namespacePattern.test(namespace))
    throw new RangeError("Invalid synthetic-world namespace");
  if (activeNamespaces.has(namespace)) throw new NamespaceInUseError(namespace);
  activeNamespaces.add(namespace);
  let released = false;
  return {
    namespace,
    release(): void {
      if (released) return;
      activeNamespaces.delete(namespace);
      released = true;
    },
  };
}
