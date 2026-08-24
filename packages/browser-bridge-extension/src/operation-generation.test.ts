/**
 * Deterministic coverage for disconnect generation fencing around browser
 * action side effects and their subsequent server publications.
 */
import { describe, expect, it, vi } from "vitest";
import {
  OperationCancelledError,
  OperationGeneration,
} from "./operation-generation";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("OperationGeneration", () => {
  it("prevents an in-flight action from publishing progress or completion", async () => {
    const generation = new OperationGeneration();
    const lease = generation.capture();
    const action = deferred();
    const progress = vi.fn();
    const completion = vi.fn();
    const session = (async () => {
      generation.assertCurrent(lease);
      await action.promise;
      generation.assertCurrent(lease);
      await progress();
      generation.assertCurrent(lease);
      await completion();
    })();

    generation.cancelAndBlock();
    action.resolve();

    await expect(session).rejects.toBeInstanceOf(OperationCancelledError);
    expect(progress).not.toHaveBeenCalled();
    expect(completion).not.toHaveBeenCalled();
  });

  it("prevents a side effect after cancellation settles an awaited lease", async () => {
    const generation = new OperationGeneration();
    const lease = generation.capture();
    const actionLease = deferred();
    const sideEffect = vi.fn();
    const action = (async () => {
      await generation.runCurrent(lease, async () => await actionLease.promise);
      sideEffect();
    })();

    generation.cancelAndBlock();
    actionLease.resolve();

    await expect(action).rejects.toBeInstanceOf(OperationCancelledError);
    expect(sideEffect).not.toHaveBeenCalled();
  });
});
