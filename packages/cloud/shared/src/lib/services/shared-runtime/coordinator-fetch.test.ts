/**
 * Verifies the deterministic deadline-bound Durable Object fetch adapter.
 */

import { expect, test } from "bun:test";
import type { RuntimeDurableObjectStub } from "../../../types/cloud-worker-env";
import { coordinatorFetch, deadlineBoundCoordinatorStub } from "./coordinator-fetch";

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

test("coordinator deadline stops after streaming response headers arrive", async () => {
  let seenSignal: AbortSignal | null | undefined;
  const stub: RuntimeDurableObjectStub = {
    fetch: async (_input, init) => {
      seenSignal = init?.signal;
      return new Response(
        new ReadableStream({
          async start(controller) {
            await Bun.sleep(30);
            if (init?.signal?.aborted) {
              controller.error(init.signal.reason);
              return;
            }
            controller.enqueue(new TextEncoder().encode("complete"));
            controller.close();
          },
        }),
      );
    },
  };

  const response = await coordinatorFetch(
    stub,
    "https://shared-runtime.internal/stream",
    undefined,
    10,
  );
  expect(await response.text()).toBe("complete");
  expect(seenSignal?.aborted).toBe(false);
});

test("coordinator deadline still aborts before response headers", async () => {
  const stub: RuntimeDurableObjectStub = {
    fetch: (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
          once: true,
        });
      }),
  };

  await expect(
    coordinatorFetch(stub, "https://shared-runtime.internal/stream", undefined, 10),
  ).rejects.toMatchObject({ name: "TimeoutError" });
});
