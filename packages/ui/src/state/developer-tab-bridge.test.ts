/** Exercises the actual tab relay protocol over an in-memory channel: target binding, duplicate suppression, streamed rows, stop, and disconnects. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationMessage } from "../api/client-types-chat";
import { DeveloperTabBridge } from "./developer-tab-bridge";

const channels = new Set<TestChannel>();
const bridges: DeveloperTabBridge[] = [];
class TestChannel {
  handlers = new Set<(event: MessageEvent<unknown>) => void>();
  sent: Record<string, unknown>[] = [];
  constructor(readonly scope = "same-authority") {
    channels.add(this);
  }
  postMessage(data: Record<string, unknown>) {
    this.sent.push(data);
    for (const channel of channels)
      if (channel !== this && channel.scope === this.scope) {
        for (const handler of channel.handlers)
          handler({ data: structuredClone(data) } as MessageEvent<unknown>);
      }
  }
  addEventListener(
    _type: "message",
    handler: (event: MessageEvent<unknown>) => void,
  ) {
    this.handlers.add(handler);
  }
  removeEventListener(
    _type: "message",
    handler: (event: MessageEvent<unknown>) => void,
  ) {
    this.handlers.delete(handler);
  }
  close() {
    channels.delete(this);
  }
}
function mount(id: string, developer: boolean, scope?: string) {
  const channel = new TestChannel(scope);
  let finish: () => void = () => {};
  const host = {
    id,
    developer,
    snapshot: () => ({ path: "/notes", conversationId: "conv" }),
    send: vi.fn(
      (_text: string, _conversationId: string, _requestId: string) =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    ),
    stop: vi.fn(),
    messages: vi.fn(),
    settled: vi.fn(),
  };
  const bridge = new DeveloperTabBridge(channel, host);
  bridges.push(bridge);
  return { bridge, host, channel, finish: () => finish() };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close();
  channels.clear();
  vi.useRealTimers();
});

describe("developer app-tab relay", () => {
  it("sends once through only the chosen app and preserves the conversation/idempotency key", async () => {
    const app = mount("app", false);
    const other = mount("other", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "Open Notes", "conv");
    expect(app.host.send).toHaveBeenCalledExactlyOnceWith(
      "Open Notes",
      "conv",
      expect.any(String),
    );
    expect(other.host.send).not.toHaveBeenCalled();
    const request = dev.channel.sent.find((m) => m.kind === "send");
    if (!request) throw new Error("Missing send");
    dev.channel.postMessage(request);
    expect(app.host.send).toHaveBeenCalledTimes(1);
    app.finish();
    await promise;
    expect(dev.host.settled).toHaveBeenCalledExactlyOnceWith("conv");
  });

  it("isolates other API authorities and never falls back or automatically resends", async () => {
    const app = mount("app", false, "other-authority");
    const dev = mount("dev", true);
    const rejected = expect(
      dev.bridge.send("app", "do it", "conv"),
    ).rejects.toThrow("not automatically resent");
    await vi.advanceTimersByTimeAsync(3000);
    await rejected;
    expect(app.host.send).not.toHaveBeenCalled();
    expect(dev.channel.sent.filter((m) => m.kind === "send")).toHaveLength(1);
  });

  it("relays only changed renderer rows and their removals for the active request", async () => {
    const app = mount("app", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "hello", "conv");
    const user: ConversationMessage = {
      id: "optimistic-user",
      role: "user",
      text: "hello",
      timestamp: 1,
    };
    app.bridge.stream([user]);
    app.bridge.stream([user]);
    expect(dev.host.messages).toHaveBeenCalledTimes(1);
    const durable = { ...user, id: "durable-user" };
    app.bridge.stream([durable]);
    expect(dev.host.messages).toHaveBeenLastCalledWith(
      "conv",
      [durable],
      ["optimistic-user"],
    );
    app.finish();
    await promise;
  });

  it("binds stop to the selected app and in-flight request", async () => {
    const app = mount("app", false);
    const other = mount("other", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "hello", "conv");
    dev.bridge.stop();
    expect(app.host.stop).toHaveBeenCalledOnce();
    expect(other.host.stop).not.toHaveBeenCalled();
    app.finish();
    await promise;
  });

  it("rejects on target close with an uncertain-outcome warning instead of replaying", async () => {
    const app = mount("app", false);
    const dev = mount("dev", true);
    const rejected = expect(
      dev.bridge.send("app", "do it", "conv"),
    ).rejects.toThrow("Check the recorded turn");
    app.bridge.close();
    await rejected;
    expect(app.host.send).toHaveBeenCalledOnce();
    app.finish();
  });

  it("ignores malformed rows and messages from a different app", async () => {
    const app = mount("app", false);
    const other = mount("other", false);
    const dev = mount("dev", true);
    const promise = dev.bridge.send("app", "hello", "conv");
    const id = app.host.send.mock.calls[0]?.[2];
    other.channel.postMessage({
      source: "other",
      target: "dev",
      id,
      kind: "done",
      error: "",
    });
    app.channel.postMessage({
      source: "app",
      target: "dev",
      id,
      kind: "messages",
      changed: [{ id: "bad" }],
      removed: [],
    });
    expect(dev.host.settled).not.toHaveBeenCalled();
    expect(dev.host.messages).not.toHaveBeenCalled();
    app.finish();
    await promise;
  });
});
