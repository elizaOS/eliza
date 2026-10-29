import { describe, expect, it } from "vitest";
import { createNativeSpeechRequests } from "./native-speech-request";

// Owner fencing of one bridge request against fake bindings. Not bridge or audio evidence.
function binding() {
  let selected = "a";
  let current = "a";
  const listeners = new Set<() => void>();
  const cancelled: string[] = [];
  return {
    cancelled,
    get watching() {
      return listeners.size;
    },
    change(next: string) {
      current = next;
      for (const listener of [...listeners]) listener();
    },
    select() {
      selected = current;
    },
    binding: {
      check() {
        if (selected !== current)
          throw new DOMException("Voice selection changed", "AbortError");
      },
      watch(onChange: () => void) {
        listeners.add(onChange);
        return () => listeners.delete(onChange);
      },
      cancel(requestId: string) {
        cancelled.push(requestId);
        return Promise.reject(Error("bridge gone"));
      },
      newRequestId: () => "req-1",
    },
  };
}

describe("native speech requests", () => {
  it("returns the result for an unchanged binding and stops watching", async () => {
    const owner = binding();
    const run = createNativeSpeechRequests(owner.binding);
    const result = await run(new AbortController().signal, async (id) => id);
    expect(result).toBe("req-1");
    expect(owner.watching).toBe(0);
    expect(owner.cancelled).toEqual([]);
  });

  it("cancels the bridge request and interrupts when the binding changes", async () => {
    const owner = binding();
    const run = createNativeSpeechRequests(owner.binding);
    let ownedSignal: AbortSignal | undefined;
    const pending = run(
      new AbortController().signal,
      async (_id, interrupted, owned) => {
        ownedSignal = owned;
        return Promise.race([new Promise<string>(() => {}), interrupted]);
      },
    );
    await Promise.resolve();
    owner.change("b");
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(owner.cancelled).toEqual(["req-1"]);
    expect(ownedSignal?.aborted).toBe(true);
    expect(owner.watching).toBe(0);
  });

  it("cancels once on the caller's abort", async () => {
    const owner = binding();
    const run = createNativeSpeechRequests({
      ...owner.binding,
      cancelledMessage: "Playback cancelled",
    });
    const controller = new AbortController();
    const pending = run(controller.signal, async (_id, interrupted) =>
      Promise.race([new Promise<never>(() => {}), interrupted]),
    );
    controller.abort();
    controller.abort();
    await expect(pending).rejects.toThrow("Playback cancelled");
    expect(owner.cancelled).toEqual(["req-1"]);
  });

  it("never returns a result that finished against a changed binding", async () => {
    const owner = binding();
    const run = createNativeSpeechRequests({
      ...owner.binding,
      watch: () => () => {},
    });
    await expect(
      run(new AbortController().signal, async () => {
        owner.change("b");
        return "late";
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("refuses to start for a stale binding or an aborted signal", async () => {
    const owner = binding();
    const run = createNativeSpeechRequests(owner.binding);
    owner.change("b");
    await expect(
      run(new AbortController().signal, async () => "never"),
    ).rejects.toMatchObject({ name: "AbortError" });
    owner.select();
    const aborted = new AbortController();
    aborted.abort();
    await expect(run(aborted.signal, async () => "never")).rejects.toThrow();
    expect(owner.cancelled).toEqual([]);
  });
});
