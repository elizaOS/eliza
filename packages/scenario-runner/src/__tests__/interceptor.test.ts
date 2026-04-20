import { describe, expect, it } from "vitest";
import { attachInterceptor } from "../interceptor.ts";

interface FakeAction {
  name: string;
  handler: (...args: unknown[]) => Promise<unknown>;
}

function makeFakeRuntime(actions: FakeAction[]) {
  return {
    actions,
    createMemory: async (_m: unknown, _table: string) => ({ id: "abc" }),
  };
}

describe("interceptor", () => {
  it("captures action invocations including parameters and result", async () => {
    const actions: FakeAction[] = [
      {
        name: "ECHO",
        handler: async () => ({ success: true, text: "hi", data: { n: 1 } }),
      },
    ];
    const rt = makeFakeRuntime(actions);
    const int = attachInterceptor(rt as unknown as Parameters<typeof attachInterceptor>[0]);
    await actions[0]!.handler({}, {}, undefined, { foo: "bar" });
    expect(int.actions).toHaveLength(1);
    expect(int.actions[0]!.actionName).toBe("ECHO");
    expect(int.actions[0]!.parameters).toEqual({ foo: "bar" });
    expect(int.actions[0]!.result?.success).toBe(true);
    expect(int.actions[0]!.result?.text).toBe("hi");
  });

  it("captures thrown errors and marks success=false", async () => {
    const actions: FakeAction[] = [
      {
        name: "BOOM",
        handler: async () => {
          throw new Error("kaboom");
        },
      },
    ];
    const rt = makeFakeRuntime(actions);
    const int = attachInterceptor(rt as unknown as Parameters<typeof attachInterceptor>[0]);
    await expect(actions[0]!.handler()).rejects.toThrow("kaboom");
    expect(int.actions).toHaveLength(1);
    expect(int.actions[0]!.error?.message).toBe("kaboom");
    expect(int.actions[0]!.result?.success).toBe(false);
  });

  it("captures memory writes by table name", async () => {
    const rt = makeFakeRuntime([]);
    const int = attachInterceptor(rt as unknown as Parameters<typeof attachInterceptor>[0]);
    await (rt as unknown as { createMemory: (m: unknown, t: string) => Promise<unknown> }).createMemory(
      {
        entityId: "e1",
        roomId: "r1",
        content: { text: "hello" },
      },
      "messages",
    );
    expect(int.memoryWrites).toHaveLength(1);
    expect(int.memoryWrites[0]!.table).toBe("messages");
    expect(int.memoryWrites[0]!.entityId).toBe("e1");
  });

  it("is idempotent — second attach does not double-wrap", async () => {
    const actions: FakeAction[] = [
      { name: "A", handler: async () => ({ success: true }) },
    ];
    const rt = makeFakeRuntime(actions);
    attachInterceptor(rt as unknown as Parameters<typeof attachInterceptor>[0]);
    const int2 = attachInterceptor(rt as unknown as Parameters<typeof attachInterceptor>[0]);
    await actions[0]!.handler();
    expect(int2.actions).toHaveLength(0); // second interceptor should not double-wrap
  });

  it("detach restores original handler", async () => {
    const actions: FakeAction[] = [
      { name: "A", handler: async () => ({ success: true }) },
    ];
    const rt = makeFakeRuntime(actions);
    const original = actions[0]!.handler;
    const int = attachInterceptor(rt as unknown as Parameters<typeof attachInterceptor>[0]);
    expect(actions[0]!.handler).not.toBe(original);
    int.detach();
    expect(actions[0]!.handler).toBe(original);
  });
});
