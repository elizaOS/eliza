/**
 * Owns runtime-specific deferred boot work from kickoff through shutdown.
 * Shutdown aborts the shared owner signal and awaits every registered task.
 * Task bodies remain owned until they settle, while an aborted owner is kept
 * as a tombstone so late registrations cannot touch a stopped runtime.
 */

import { logger } from "@elizaos/core";

type RuntimeIdentity = object;
type DeferredBootTask = (signal: AbortSignal) => Promise<unknown>;

interface DeferredBootOwner {
  readonly controller: AbortController;
  readonly tasks: Set<Promise<void>>;
}

const owners = new WeakMap<RuntimeIdentity, DeferredBootOwner>();

function ownerFor(runtime: RuntimeIdentity): DeferredBootOwner {
  let owner = owners.get(runtime);
  if (!owner) {
    owner = {
      controller: new AbortController(),
      tasks: new Set(),
    };
    owners.set(runtime, owner);
  }
  return owner;
}

export function trackDeferredBootTask(
  runtime: RuntimeIdentity,
  task: DeferredBootTask,
): Promise<void> {
  const owner = ownerFor(runtime);
  const execution = Promise.resolve()
    .then(() => {
      if (owner.controller.signal.aborted) return;
      return task(owner.controller.signal);
    })
    .then(() => undefined);

  // Cancellation must not release shutdown before the task has closed its
  // resources. Task bodies receive the owner signal and settle cooperatively.
  const release = execution.catch((error) => {
    if (!owner.controller.signal.aborted) throw error;
    logger.debug(
      `[DeferredBootOwner] task settled after cancellation: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  owner.tasks.add(release);
  void release.then(
    () => owner.tasks.delete(release),
    () => owner.tasks.delete(release),
  );
  return release;
}

export async function cancelAndDrainDeferredBoot(
  runtime: RuntimeIdentity,
): Promise<number> {
  const owner = ownerFor(runtime);

  if (!owner.controller.signal.aborted) {
    owner.controller.abort(
      new Error("Runtime shutdown cancelled deferred boot"),
    );
  }

  let drained = 0;
  while (owner.tasks.size > 0) {
    const batch = [...owner.tasks];
    drained += batch.length;
    await Promise.allSettled(batch);
  }
  // Keep the aborted owner in the WeakMap. A late dynamic import or startup
  // callback may attempt to register more work after shutdown; reusing the
  // tombstone makes that registration a no-op instead of creating a fresh
  // live owner for a closed runtime.
  return drained;
}

/** @internal */
export function pendingDeferredBootTaskCount(runtime: RuntimeIdentity): number {
  return owners.get(runtime)?.tasks.size ?? 0;
}
