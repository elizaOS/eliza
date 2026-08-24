/**
 * Covers the per-request Worker bindings shim.
 *
 * On Workers, secrets live on `c.env` rather than `process.env`, so
 * `getCloudAwareEnv()` overlays the request store on top of the process
 * environment. Two rules make that safe: only STRING bindings shadow — a
 * non-string binding (R2 bucket, Queue, Hyperdrive config) must fall through to
 * `process.env` rather than being handed to a caller expecting a secret string
 * — and outside a request the process environment is returned untouched, so
 * Node callers are unaffected.
 *
 * Environment writes are scoped to this suite's own variable names and undone
 * afterwards.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  getCloudAwareEnv,
  getCloudBinding,
  hasCloudBindingsContext,
  runWithCloudBindings,
  runWithCloudBindingsAsync,
} from "./cloud-bindings";

const VAR = "TEST_CLOUD_BINDING_VAR";
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  delete process.env[VAR];
});

describe("outside a request", () => {
  test("reports no bindings context", () => {
    expect(hasCloudBindingsContext()).toBe(false);
  });

  test("returns process.env itself, not a copy or proxy", () => {
    expect(getCloudAwareEnv()).toBe(process.env);
  });

  test("reads a process variable normally", () => {
    process.env[VAR] = "from-process";
    expect(getCloudAwareEnv()[VAR]).toBe("from-process");
  });

  test("resolves no worker binding", () => {
    expect(getCloudBinding("ANY")).toBeUndefined();
  });
});

describe("inside a request", () => {
  test("reports a bindings context", () => {
    expect(runWithCloudBindings({}, () => hasCloudBindingsContext())).toBe(true);
  });

  test("a string binding shadows the process variable", () => {
    process.env[VAR] = "from-process";
    const seen = runWithCloudBindings({ [VAR]: "from-worker" }, () => getCloudAwareEnv()[VAR]);
    expect(seen).toBe("from-worker");
  });

  test("a string binding is visible even with no process variable", () => {
    const seen = runWithCloudBindings({ [VAR]: "worker-only" }, () => getCloudAwareEnv()[VAR]);
    expect(seen).toBe("worker-only");
  });

  test("falls through to process.env for an unbound name", () => {
    process.env[VAR] = "from-process";
    expect(runWithCloudBindings({ OTHER: "x" }, () => getCloudAwareEnv()[VAR])).toBe(
      "from-process",
    );
  });

  test("a NON-string binding does not shadow the process variable", () => {
    // R2 buckets, Queues and Hyperdrive configs live in the same store; handing
    // one to a caller expecting a secret string would be worse than missing it.
    process.env[VAR] = "from-process";
    for (const binding of [{ bucket: true }, 42, null, undefined, ["a"], () => "x"]) {
      const seen = runWithCloudBindings({ [VAR]: binding }, () => getCloudAwareEnv()[VAR]);
      expect(seen).toBe("from-process");
    }
  });

  test("does not leak the store's inherited properties as env values", () => {
    const store = Object.create({ INHERITED: "nope" }) as Record<string, unknown>;
    expect(runWithCloudBindings(store, () => getCloudAwareEnv().INHERITED)).toBeUndefined();
  });

  test("passes symbol lookups through to process.env", () => {
    const seen = runWithCloudBindings({ [VAR]: "from-worker" }, () =>
      Object.prototype.toString.call(getCloudAwareEnv()),
    );
    expect(seen).toBe("[object Object]");
  });

  test("clears the context once the scope exits", () => {
    runWithCloudBindings({ [VAR]: "from-worker" }, () => undefined);
    expect(hasCloudBindingsContext()).toBe(false);
    expect(getCloudAwareEnv()).toBe(process.env);
  });

  test("returns the callback's value", () => {
    expect(runWithCloudBindings({}, () => 7)).toBe(7);
  });
});

describe("getCloudBinding", () => {
  test("returns a non-string binding the env view deliberately hides", () => {
    const bucket = { put: () => undefined };
    expect(runWithCloudBindings({ R2: bucket }, () => getCloudBinding("R2"))).toBe(bucket);
  });

  test("returns undefined for an unbound name inside a request", () => {
    expect(runWithCloudBindings({ A: 1 }, () => getCloudBinding("B"))).toBeUndefined();
  });
});

describe("scoping", () => {
  test("a nested scope shadows and then restores the outer bindings", () => {
    const observed = runWithCloudBindings({ [VAR]: "outer" }, () => {
      const inner = runWithCloudBindings({ [VAR]: "inner" }, () => getCloudAwareEnv()[VAR]);
      return { inner, after: getCloudAwareEnv()[VAR] };
    });
    expect(observed).toEqual({ inner: "inner", after: "outer" });
  });

  test("the async variant survives an await boundary", async () => {
    const seen = await runWithCloudBindingsAsync({ [VAR]: "from-worker" }, async () => {
      await tick();
      return getCloudAwareEnv()[VAR];
    });
    expect(seen).toBe("from-worker");
  });

  test("concurrent requests never observe each other's bindings", async () => {
    const [a, b] = await Promise.all([
      runWithCloudBindingsAsync({ [VAR]: "req-a" }, async () => {
        await tick();
        await tick();
        return getCloudAwareEnv()[VAR];
      }),
      runWithCloudBindingsAsync({ [VAR]: "req-b" }, async () => {
        await tick();
        return getCloudAwareEnv()[VAR];
      }),
    ]);
    expect([a, b]).toEqual(["req-a", "req-b"]);
  });
});
