/**
 * Verifies the deterministic deadline-bound Durable Object fetch adapter.
 */

import { expect, test } from "bun:test";
import type { RuntimeDurableObjectStub } from "../../../types/cloud-worker-env";
import { deadlineBoundCoordinatorStub } from "./coordinator-fetch";

test("deadline-bound coordinator stubs preserve Request inputs", async () => {
  const controller = new AbortController();
  const request = new Request("https://shared-runtime.internal/bridge", {
    method: "POST",
    body: "{}",
    signal: controller.signal,
  });
  let seenInput: RequestInfo | URL | undefined;
  let seenSignal: AbortSignal | null | undefined;
  const stub: RuntimeDurableObjectStub = {
    fetch: async (input, init) => {
      seenInput = input;
      seenSignal = init?.signal;
      return Response.json({ ok: true });
    },
  };

  const response = await deadlineBoundCoordinatorStub(stub).fetch(request);

  expect(response.ok).toBe(true);
  expect(seenInput).toBe(request);
  expect(seenSignal).toBeInstanceOf(AbortSignal);
  expect(seenSignal).not.toBe(controller.signal);
  expect(seenSignal?.aborted).toBe(false);
  controller.abort();
  expect(seenSignal?.aborted).toBe(true);
});
