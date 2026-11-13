import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeRuntimePreparation } from "../native-runtime-preparation";

afterEach(() => vi.useRealTimers());
describe("native startup admission", () => {
  it("joins one admission for each base in the captured generation", async () => {
    let release!: () => void;
    const port = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
    const prepare = createNativeRuntimePreparation(port);
    const first = prepare("eliza-local-agent://ipc", 1000);
    const second = prepare("eliza-local-agent://ipc", 1000);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(port).toHaveBeenCalledOnce();
    release();
    await first;
    await prepare("eliza-local-agent://ipc", 1000);
    expect(port).toHaveBeenCalledOnce();
  });
  it("does not retry a refused provider behind the owner's back", async () => {
    const failure = new Error("Provider was not admitted");
    const port = vi.fn(async () => { throw failure; });
    const prepare = createNativeRuntimePreparation(port);
    await expect(prepare("eliza-local-agent://ipc", 1000)).rejects.toBe(failure);
    await expect(prepare("eliza-local-agent://ipc", 1000)).rejects.toBe(failure);
    expect(port).toHaveBeenCalledOnce();
    await expect(createNativeRuntimePreparation(port)("eliza-local-agent://ipc", 1000)).rejects.toBe(failure);
    expect(port).toHaveBeenCalledTimes(2);
  });
  it("aborts admission when its startup generation retires", async () => {
    const parent = new AbortController();
    let captured!: AbortSignal;
    const port = vi.fn((_base, signal: AbortSignal) => { captured = signal; return new Promise<void>(() => {}); });
    const prepare = createNativeRuntimePreparation(port, parent.signal);
    const pending = prepare("eliza-local-agent://ipc", 1000);
    const assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await Promise.resolve();
    parent.abort();
    await assertion;
    expect(captured.aborted).toBe(true);
    await expect(prepare("other", 1000)).rejects.toMatchObject({ name: "AbortError" });
    expect(port).toHaveBeenCalledOnce();
  });
  it("uses the phase deadline and cancels hung admission", async () => {
    vi.useFakeTimers();
    let captured!: AbortSignal;
    const prepare = createNativeRuntimePreparation((_base, signal) => { captured = signal; return new Promise<void>(() => {}); });
    const pending = prepare("eliza-local-agent://ipc", 30000);
    const assertion = expect(pending).rejects.toThrow("startup deadline");
    await vi.advanceTimersByTimeAsync(12000);
    expect(captured.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(18000);
    await assertion;
    expect(captured.aborted).toBe(true);
  });
  it("does not call a host after an already cancelled generation", async () => {
    const parent = new AbortController();
    parent.abort();
    const port = vi.fn(async () => {});
    await expect(createNativeRuntimePreparation(port, parent.signal)("local", 1000)).rejects.toMatchObject({ name: "AbortError" });
    expect(port).not.toHaveBeenCalled();
  });
  it("does not begin admission after the phase budget has already expired", async () => {
    const port = vi.fn(async () => {});
    await expect(createNativeRuntimePreparation(port)("local", 0)).rejects.toThrow("startup deadline");
    await expect(createNativeRuntimePreparation(port)("local", -1)).rejects.toThrow("startup deadline");
    expect(port).not.toHaveBeenCalled();
  });
});
