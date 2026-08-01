/**
 * Owns runtime-specific deferred boot work from kickoff through shutdown.
 * Shutdown aborts the shared owner signal and waits for every registered task,
 * so plugin registration and warmups cannot mutate a closed runtime or database.
 */

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
  const promise = Promise.resolve()
    .then(() => {
      if (owner.controller.signal.aborted) return;
      return task(owner.controller.signal);
    })
    .then(() => undefined);
  owner.tasks.add(promise);
  void promise.then(
    () => owner.tasks.delete(promise),
    () => owner.tasks.delete(promise),
  );
  return promise;
}

export async function cancelAndDrainDeferredBoot(
  runtime: RuntimeIdentity,
): Promise<number> {
  const owner = owners.get(runtime);
  if (!owner) return 0;

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
  owners.delete(runtime);
  return drained;
}

/** @internal */
export function pendingDeferredBootTaskCount(runtime: RuntimeIdentity): number {
  return owners.get(runtime)?.tasks.size ?? 0;
}
