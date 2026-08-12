/**
 * Private cloud registration state machine (#18056 review repairs).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensurePrivateCloudSurfaces,
  forceNewPrivateCloudGenerationForTests,
  getPrivateCloudRegistrationSnapshot,
  pathNeedsPrivateCloudSurfaces,
  resetPrivateCloudRegistrationForTests,
  retryPrivateCloudSurfaces,
  setPrivateCloudLoadForTests,
  subscribePrivateCloudRegistration,
} from "./private-cloud-registration";

const appMainSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../../../app/src/main.tsx"),
  "utf8",
);

afterEach(() => {
  resetPrivateCloudRegistrationForTests();
});

describe("pathNeedsPrivateCloudSurfaces", () => {
  it("is false for public auth and marketing paths", () => {
    for (const path of [
      "/login",
      "/join",
      "/get-started",
      "/auth/success",
      "/payment/abc",
      "/",
      "/chat/foo",
    ]) {
      expect(pathNeedsPrivateCloudSurfaces(path), path).toBe(false);
    }
  });

  it("is true only for dashboard console paths", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/",
      "/dashboard/billing",
      "/dashboard/admin",
      "dashboard/agents",
    ]) {
      expect(pathNeedsPrivateCloudSurfaces(path), path).toBe(true);
    }
  });
});

describe("getPrivateCloudRegistrationSnapshot stability", () => {
  it("returns the same object identity until the store mutates", () => {
    const a = getPrivateCloudRegistrationSnapshot();
    const b = getPrivateCloudRegistrationSnapshot();
    expect(a).toBe(b);
    expect(a).toEqual({ status: "idle", error: null });
  });

  it("notifies subscribers only when status changes and keeps snapshot identity", async () => {
    const seen: string[] = [];
    const unsub = subscribePrivateCloudRegistration(() => {
      seen.push(getPrivateCloudRegistrationSnapshot().status);
    });

    setPrivateCloudLoadForTests(async () => {
      /* no-op */
    });
    const first = getPrivateCloudRegistrationSnapshot();
    const pending = ensurePrivateCloudSurfaces();
    const mid = getPrivateCloudRegistrationSnapshot();
    expect(mid.status).toBe("pending");
    expect(mid).not.toBe(first);
    expect(getPrivateCloudRegistrationSnapshot()).toBe(mid);

    await pending;
    const ready = getPrivateCloudRegistrationSnapshot();
    expect(ready.status).toBe("ready");
    expect(ready).not.toBe(mid);
    expect(getPrivateCloudRegistrationSnapshot()).toBe(ready);
    expect(seen).toContain("pending");
    expect(seen).toContain("ready");
    unsub();
  });
});

describe("ensurePrivateCloudSurfaces", () => {
  it("starts idle and never auto-loads until ensure is called", () => {
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("idle");
  });

  it("reaches ready after successful ensure", async () => {
    setPrivateCloudLoadForTests(async () => {
      /* no-op success without importing private domains */
    });
    const pending = ensurePrivateCloudSurfaces();
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("pending");
    await pending;
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");
    expect(getPrivateCloudRegistrationSnapshot().error).toBeNull();
  });

  it("records error status, avoids unhandled rejection, and retries from error", async () => {
    let attempts = 0;
    setPrivateCloudLoadForTests(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("import batch failed");
      }
    });

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    try {
      void ensurePrivateCloudSurfaces();
      await Promise.resolve();
      await Promise.resolve();
      expect(getPrivateCloudRegistrationSnapshot().status).toBe("error");
      expect(getPrivateCloudRegistrationSnapshot().error?.message).toBe(
        "import batch failed",
      );
      expect(unhandled).toEqual([]);

      await retryPrivateCloudSurfaces();
      expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");
      expect(attempts).toBe(2);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("does not let a pre-reset failure overwrite a later success", async () => {
    type Gate = {
      resolve: () => void;
      reject: (e: Error) => void;
      promise: Promise<void>;
    };
    const gates: Gate[] = [];
    const makeGate = (): Gate => {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { resolve, reject, promise };
    };

    setPrivateCloudLoadForTests(async () => {
      const gate = makeGate();
      gates.push(gate);
      await gate.promise;
    });

    const stale = ensurePrivateCloudSurfaces();
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("pending");
    expect(gates).toHaveLength(1);

    // Reset while the first loader is unresolved, as a test teardown can do
    // after an early assertion failure, then start a fresh generation.
    resetPrivateCloudRegistrationForTests();
    setPrivateCloudLoadForTests(async () => {
      const gate = makeGate();
      gates.push(gate);
      await gate.promise;
    });
    const fresh = ensurePrivateCloudSurfaces();
    expect(gates).toHaveLength(2);
    gates[1].resolve();
    await fresh;
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");

    // The stale completion is deliberately last. It is quarantined and its
    // promise resolves without demoting the fresh ready snapshot.
    gates[0].reject(new Error("stale failure"));
    await expect(stale).resolves.toBeUndefined();
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");
  });

  it("ignores reverse-order completion across overlapping generations", async () => {
    // Discriminating test: two loaders run concurrently (A then forced B).
    // B succeeds first → ready. A then fails. Without the generation guard,
    // A's catch would demote ready → error. The force-new-generation test hook
    // is the only way to start B while A is still in flight (production shares
    // the pending promise).
    type Gate = {
      resolve: () => void;
      reject: (e: Error) => void;
      promise: Promise<void>;
    };
    const gates: Gate[] = [];
    const makeGate = (): Gate => {
      let resolve!: () => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { resolve, reject, promise };
    };

    setPrivateCloudLoadForTests(async () => {
      const gate = makeGate();
      gates.push(gate);
      await gate.promise;
    });

    const attemptA = ensurePrivateCloudSurfaces();
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("pending");
    expect(gates).toHaveLength(1);

    // Start generation B while A is still awaiting its gate.
    const attemptB = forceNewPrivateCloudGenerationForTests();
    expect(gates).toHaveLength(2);
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("pending");

    // Reverse completion: B wins first.
    gates[1].resolve();
    await attemptB;
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");

    // Stale A fails after B already committed ready — must not overwrite.
    // Quarantined generations resolve without mutating the snapshot.
    gates[0].reject(new Error("stale generation failure"));
    await expect(attemptA).resolves.toBeUndefined();
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");
    expect(getPrivateCloudRegistrationSnapshot().error).toBeNull();
  });

  it("returns the in-flight promise instead of starting a second loader while pending", async () => {
    let starts = 0;
    let resolveLoad!: () => void;
    setPrivateCloudLoadForTests(
      () =>
        new Promise<void>((res) => {
          starts += 1;
          resolveLoad = res;
        }),
    );

    const a = ensurePrivateCloudSurfaces();
    const b = ensurePrivateCloudSurfaces();
    const c = retryPrivateCloudSurfaces(); // pending → same promise
    expect(starts).toBe(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
    resolveLoad();
    await a;
    expect(getPrivateCloudRegistrationSnapshot().status).toBe("ready");
  });
});

describe("web shell public boot contract", () => {
  it("does not invoke private registration from packages/app main shell factory", () => {
    expect(appMainSource).toContain("registerPublicCloudSurfaces()");
    expect(appMainSource).toContain(
      'import("@elizaos/ui/cloud/register-public")',
    );
    const factory = appMainSource.slice(
      appMainSource.indexOf("const CloudRouterShell = lazy"),
      appMainSource.indexOf("const ChatWidgetHarness"),
    );
    expect(factory).toContain("registerPublicCloudSurfaces()");
    expect(factory).not.toContain("registerPrivateCloudSurfaces");
    expect(factory).not.toContain("ensurePrivateCloudSurfaces");
    expect(factory).not.toMatch(
      /import\("@elizaos\/ui\/cloud\/register-all"\)/,
    );
  });
});
