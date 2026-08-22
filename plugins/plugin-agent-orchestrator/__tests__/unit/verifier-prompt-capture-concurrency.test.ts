/**
 * Exercises shared-runtime verifier observer ownership with a deterministic
 * barrier, without booting the broader scenario runtime.
 */

import { describe, expect, it, vi } from "vitest";
import { installAttemptScopedVerifierPromptCapture } from "../../test/scenarios/_helpers/verifier-prompt-capture";

type ModelRuntime = Parameters<
  typeof installAttemptScopedVerifierPromptCapture
>[0];

describe("verifier prompt capture concurrent ownership", () => {
  it("allows one overlapping attempt and fails the other closed", async () => {
    const originalUseModel = vi.fn(async () => "completion");
    const runtime = { useModel: originalUseModel } as unknown as ModelRuntime;
    const captures = [vi.fn(), vi.fn()];
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const installers = captures.map((capture) =>
      barrier.then(() =>
        installAttemptScopedVerifierPromptCapture(runtime, capture),
      ),
    );

    releaseBarrier();
    const results = await Promise.allSettled(installers);
    const installed = results.filter(
      (result): result is PromiseFulfilledResult<() => void> =>
        result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );

    expect(installed).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toEqual(
      expect.objectContaining({
        message:
          "verifier prompt capture is already installed for this runtime attempt",
      }),
    );
    await runtime.useModel(
      "TEXT_SMALL" as never,
      {
        prompt: "You are a demanding engineering manager during overlap",
      } as never,
    );
    expect(captures[0].mock.calls.length + captures[1].mock.calls.length).toBe(
      1,
    );

    installed[0]?.value();
    expect(runtime.useModel).toBe(originalUseModel);
  });
});
