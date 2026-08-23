/**
 * Colocated coverage for the /api/plugins cold-load deadline helper. Drives the
 * real module: the wait constant the route uses, and resolveWithinDeadline
 * racing a promise against that timer (settled value, timeout null, rejection
 * unmasked, concurrent independent calls).
 */
import { describe, expect, it } from "vitest";
import {
  PLUGIN_REGISTRY_LOAD_DEADLINE_MS,
  resolveWithinDeadline,
} from "./plugin-registry-load-deadline";

describe("PLUGIN_REGISTRY_LOAD_DEADLINE_MS", () => {
  it("is 2000 milliseconds", () => {
    expect(PLUGIN_REGISTRY_LOAD_DEADLINE_MS).toBe(2_000);
  });
});

describe("resolveWithinDeadline", () => {
  it("returns the value when the promise is already settled", async () => {
    await expect(
      resolveWithinDeadline(Promise.resolve("warm"), 1_000),
    ).resolves.toBe("warm");
  });

  it("returns a delayed value that settles inside the deadline", async () => {
    const warm = new Promise<string>((resolve) => {
      setTimeout(() => resolve("warm"), 5);
    });
    await expect(resolveWithinDeadline(warm, 80)).resolves.toBe("warm");
  });

  it("returns null when the promise is still pending at the deadline", async () => {
    const never = new Promise<string>(() => {});
    await expect(resolveWithinDeadline(never, 20)).resolves.toBeNull();
  });

  it("returns null when a late resolve happens after the deadline", async () => {
    let resolveLate: (value: string) => void = () => {
      throw new Error("late resolver was not captured");
    };
    const late = new Promise<string>((resolve) => {
      resolveLate = resolve;
    });
    await expect(resolveWithinDeadline(late, 15)).resolves.toBeNull();
    resolveLate("warm-after-deadline");
    await expect(late).resolves.toBe("warm-after-deadline");
  });

  it("propagates rejection instead of converting it into a timeout null", async () => {
    const boom = Promise.reject(new Error("registry import failed"));
    await expect(resolveWithinDeadline(boom, 1_000)).rejects.toThrow(
      "registry import failed",
    );
  });

  it("does not rewrite an already-returned timeout null when the promise later rejects", async () => {
    let rejectLate: (error: Error) => void = () => {
      throw new Error("late rejector was not captured");
    };
    const late = new Promise<string>((_, reject) => {
      rejectLate = reject;
    });
    const absorbed = late.then(
      () => undefined,
      () => undefined,
    );
    await expect(resolveWithinDeadline(late, 15)).resolves.toBeNull();
    rejectLate(new Error("registry import failed after deadline"));
    await absorbed;
  });

  it("passes through falsy settled values instead of treating them as a timeout", async () => {
    await expect(
      resolveWithinDeadline(Promise.resolve(0), 1_000),
    ).resolves.toBe(0);
    await expect(
      resolveWithinDeadline(Promise.resolve(""), 1_000),
    ).resolves.toBe("");
    await expect(
      resolveWithinDeadline(Promise.resolve(false), 1_000),
    ).resolves.toBe(false);
    await expect(
      resolveWithinDeadline(Promise.resolve(undefined), 1_000),
    ).resolves.toBeUndefined();
  });

  it("returns null when the promise itself settles to null", async () => {
    await expect(
      resolveWithinDeadline(Promise.resolve(null), 1_000),
    ).resolves.toBeNull();
  });

  it("lets an already-settled promise win a 0ms deadline (microtask before timer)", async () => {
    await expect(
      resolveWithinDeadline(Promise.resolve("warm"), 0),
    ).resolves.toBe("warm");
  });

  it("returns null for a pending promise at a 0ms deadline", async () => {
    const never = new Promise<string>(() => {});
    await expect(resolveWithinDeadline(never, 0)).resolves.toBeNull();
  });

  it("runs independent races without sharing a winner", async () => {
    const never = new Promise<string>(() => {});
    const [timedOut, settled] = await Promise.all([
      resolveWithinDeadline(never, 15),
      resolveWithinDeadline(Promise.resolve("warm"), 1_000),
    ]);
    expect(timedOut).toBeNull();
    expect(settled).toBe("warm");
  });
});
