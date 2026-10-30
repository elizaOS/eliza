import { describe, expect, it } from "vitest";
import {
  type AccountReturnBinding,
  createWorkspaceAppReturn,
  watchForegroundAccountReturn,
} from "../src/sdk/app-return.js";

const config = {
  callbackUrl: "https://app.example/workspace/callback",
  pluginName: "ProductConnection",
  methods: ["prepare", "consume", "cancel"],
};
const flow = createWorkspaceAppReturn(config);
const state = "A".repeat(43),
  redirectUrl = `${config.callbackUrl}?state=${state}`;
const binding: AccountReturnBinding = {
  client: {},
  environment: "production",
  userId: "owner",
  organizationId: "org",
  sessionId: "session",
  credentialId: "credential",
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("registered Workspace returns", () => {
  it("accepts only its configured callback, plugin, complete bridge and literal state", () => {
    expect(flow.redirectAllowed(redirectUrl)).toBe(true);
    for (const value of [
      `${redirectUrl}&state=${state}`,
      `${redirectUrl}#extra`,
      redirectUrl.replace("app.example", "other.example"),
      redirectUrl.replace("state=", "%73tate="),
      redirectUrl.replace("state=A", "state=%41"),
    ])
      expect(flow.redirectAllowed(value)).toBe(false);
    expect(
      flow.available([
        {
          name: config.pluginName,
          methods: config.methods.map((name) => ({ name })),
        },
      ]),
    ).toBe(true);
    expect(
      flow.available([
        { name: "Other", methods: config.methods.map((name) => ({ name })) },
      ]),
    ).toBe(false);
    const other = createWorkspaceAppReturn({
      ...config,
      callbackUrl: "https://other.example/callback",
    });
    expect(other.redirectAllowed(redirectUrl)).toBe(false);
  });
  it("cancels the issued nonce when the owner changes during preparation", async () => {
    let owner = binding;
    const cancelled: string[] = [];
    const port = {
      prepare: async () => {
        owner = { ...binding, credentialId: "new" };
        return { supported: true, redirectUrl, state };
      },
      cancel: async (s: string) => {
        cancelled.push(s);
      },
      consume: async () => ({ result: "none" as const }),
      subscribe: async () => ({ remove() {} }),
    };
    await expect(
      flow.prepare(port, binding, () => owner),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(cancelled).toEqual([state]);
  });
  it("does not publish a result from a retired identity or a late registration", async () => {
    const registration = deferred<{ remove(): void }>();
    let reads = 0,
      removed = 0,
      published = 0;
    const port = {
      prepare: async () => ({ supported: false }),
      cancel: async () => {},
      consume: async () => {
        reads++;
        return { result: "connected" as const, connectionId: "grant" };
      },
      subscribe: () => registration.promise,
    };
    const watcher = flow.watch(
      port,
      binding,
      () => binding,
      () => {
        published++;
      },
      () => {
        throw Error("unexpected");
      },
    );
    watcher.close();
    registration.resolve({
      remove() {
        removed++;
      },
    });
    await watcher.ready;
    expect({ reads, removed, published }).toEqual({
      reads: 0,
      removed: 1,
      published: 0,
    });
  });
  it("coalesces a return arriving while a consume is in flight and validates the result", async () => {
    let notify = () => {},
      reads = 0;
    const first = deferred<{ result: "none" }>(),
      seen: unknown[] = [];
    const watcher = flow.watch(
      {
        prepare: async () => ({ supported: false }),
        cancel: async () => {},
        consume: async () =>
          ++reads === 1
            ? first.promise
            : { result: "connected", connectionId: "owned-grant" },
        subscribe: async (fn) => {
          notify = fn;
          return { remove() {} };
        },
      },
      binding,
      () => binding,
      (result) => seen.push(result),
      () => {
        throw Error("unexpected");
      },
    );
    await Promise.resolve();
    notify();
    notify();
    first.resolve({ result: "none" });
    await watcher.ready;
    await Promise.resolve();
    expect(reads).toBe(2);
    expect(seen).toEqual([
      { result: "connected", connectionId: "owned-grant" },
    ]);
    watcher.close();
  });
});
describe("foreground account returns", () => {
  it("requires observed background after arm, consumes once, and compares client identity", async () => {
    let foreground = true,
      focus = () => {},
      visibility = () => {},
      native = () => {},
      refreshes = 0,
      current = binding;
    const watcher = watchForegroundAccountReturn({
      binding,
      current: () => current,
      foreground: () => foreground,
      refresh: () => {
        refreshes++;
      },
      onFocus: (fn) => {
        focus = fn;
        return () => {};
      },
      onVisibilityChange: (fn) => {
        visibility = fn;
        return () => {};
      },
      onNativeResume: async (fn) => {
        native = fn;
        return { remove() {} };
      },
    });
    await watcher.ready;
    watcher.arm();
    focus();
    native();
    expect(refreshes).toBe(0);
    foreground = false;
    visibility();
    foreground = true;
    native();
    focus();
    expect(refreshes).toBe(1);
    watcher.arm();
    current = { ...binding, client: {} };
    foreground = false;
    visibility();
    foreground = true;
    focus();
    expect(refreshes).toBe(1);
    watcher.close();
  });
});
