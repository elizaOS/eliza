import { expect, spyOn, test } from "bun:test";
import { coordinatorFetch, SHARED_RUNTIME_TURN_DEADLINE_MS } from "./coordinator-fetch";

test("late inference headers survive the control budget while control reads remain bounded", async () => {
  const realTimer = globalThis.setTimeout;
  const deadlines: number[] = [];
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) => {
    deadlines.push(Number(delay));
    return realTimer(callback, delay === 75_000 ? 100 : delay === 10_000 ? 5 : delay, ...args);
  }) as typeof setTimeout);
  const stub = {
    fetch: async (_input: RequestInfo | URL, init?: RequestInit) => {
      await Bun.sleep(20);
      init?.signal?.throwIfAborted();
      return Response.json({ text: "completed inference" });
    },
  };
  try {
    expect(
      (
        await coordinatorFetch(
          stub,
          "https://shared-runtime.internal/bridge",
          undefined,
          SHARED_RUNTIME_TURN_DEADLINE_MS,
        )
      ).ok,
    ).toBe(true);
    await expect(
      coordinatorFetch(stub, "https://shared-runtime.internal/history"),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(deadlines).toEqual([75_000, 10_000]);
  } finally {
    timer.mockRestore();
  }
});

test("inference deadline is finite and caller cancellation wins", async () => {
  const realTimer = globalThis.setTimeout;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback, delay, ...args) =>
    realTimer(callback, delay === 75_000 ? 10 : delay, ...args)) as typeof setTimeout);
  const stub = {
    fetch: (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) throw new Error("Expected cancellation signal");
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      }),
  };
  try {
    const caller = new AbortController();
    const request = coordinatorFetch(
      stub,
      "https://shared-runtime.internal/bridge",
      { signal: caller.signal },
      SHARED_RUNTIME_TURN_DEADLINE_MS,
    );
    caller.abort(new Error("caller cancelled"));
    await expect(request).rejects.toThrow("caller cancelled");
    await expect(
      coordinatorFetch(
        stub,
        "https://shared-runtime.internal/bridge",
        undefined,
        SHARED_RUNTIME_TURN_DEADLINE_MS,
      ),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  } finally {
    timer.mockRestore();
  }
});
