// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { listenForNavigateViewRequests } from "../../events";
import { navigateDeepLink } from "./navigate-deep-link";

const target = {
  conversationId: "d13804ae-4156-47ba-abd1-12961448106e",
  messageId: "19ea32c4-43d5-4dc9-af91-aeceae70bdd3",
};
afterEach(() => {
  const stop = listenForNavigateViewRequests(() => true);
  stop();
});
it("retains a bare cold chat request until its destination applies it", async () => {
  let completed = false;
  const result = navigateDeepLink("/chat");
  void result?.then(() => {
    completed = true;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  let release: (value: boolean) => void = () => {};
  const pending = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const stop = listenForNavigateViewRequests((event) => {
    expect(event.detail.payload).toEqual({ kind: "notification-chat" });
    return pending;
  });
  await Promise.resolve();
  expect(completed).toBe(false);
  release(true);
  await expect(result).resolves.toBe(true);
  stop();
});
it("awaits asynchronous application and keeps two different anchors in FIFO order", async () => {
  const second = {
    ...target,
    messageId: "0168583b-8aea-4420-a6d7-ed2339bca079",
  };
  const first = navigateDeepLink("/chat", target);
  const later = navigateDeepLink("/chat", second);
  const applied: unknown[] = [];
  let release: (value: boolean) => void = () => {};
  const pending = new Promise<boolean>((resolve) => {
    release = resolve;
  });
  const stop = listenForNavigateViewRequests((event) => {
    applied.push(event.detail.payload);
    return applied.length === 1 ? pending : true;
  });
  expect(applied).toEqual([{ kind: "notification-chat", target }]);
  release(true);
  await expect(first).resolves.toBe(true);
  await expect(later).resolves.toBe(true);
  expect(applied).toEqual([
    { kind: "notification-chat", target },
    { kind: "notification-chat", target: second },
  ]);
  stop();
});
it("does not acknowledge an unmounted asynchronous owner", async () => {
  const result = navigateDeepLink("/chat", target);
  let release: (value: boolean) => void = () => {};
  const stop = listenForNavigateViewRequests(
    () =>
      new Promise<boolean>((resolve) => {
        release = resolve;
      }),
  );
  stop();
  let acknowledged = false;
  void result?.then(() => {
    acknowledged = true;
  });
  release(true);
  await Promise.resolve();
  expect(acknowledged).toBe(false);
  const retry = listenForNavigateViewRequests(() => true);
  await expect(result).resolves.toBe(true);
  retry();
});
it.each([
  { messageId: target.messageId },
  { ...target, messageId: "missing" },
  { ...target, conversationId: "foreign" },
])(
  "rejects malformed claimed anchors without opening legacy chat",
  async (data) => {
    const listener = vi.fn(() => true);
    const stop = listenForNavigateViewRequests(listener);
    await expect(navigateDeepLink("/chat", data)).resolves.toBe(false);
    expect(listener).not.toHaveBeenCalled();
    stop();
  },
);

it.each(["decline", "reject"])(
  "hands off asynchronous %s to another already-mounted owner exactly once",
  async (mode) => {
    const result = navigateDeepLink("/chat", target);
    let release: (value: boolean) => void = () => {};
    let reject: (error: Error) => void = () => {};
    const pending = new Promise<boolean>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    const first = vi.fn(() => pending);
    const stopFirst = listenForNavigateViewRequests(first);
    const second = vi.fn(() => true);
    const stopSecond = listenForNavigateViewRequests(second);
    expect(second).not.toHaveBeenCalled();
    if (mode === "decline") release(false);
    else reject(Error("not applied"));
    await expect(result).resolves.toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    stopFirst();
    stopSecond();
  },
);
