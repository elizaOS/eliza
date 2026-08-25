import { describe, it, expect, vi } from "vitest";

import { CloudRuntimeProxy } from "./cloud-proxy";

function makeClient() {
  return {
    sendMessage: vi.fn(async () => "reply text"),
    sendMessageStream: vi.fn(async function* () {
      yield { type: "chunk", data: { text: "a" } };
      yield { type: "chunk", data: { text: 42 } };
      yield { type: "done", data: {} };
      yield { type: "chunk", data: { text: "b" } };
    }),
    getAgent: vi.fn(async () => ({ status: "online", agentName: "solo" })),
    heartbeat: vi.fn(async () => true),
  };
}

describe("CloudRuntimeProxy", () => {
  it("exposes the agent name captured at construction", () => {
    const proxy = new CloudRuntimeProxy(makeClient() as never, "agent-1", "solo");
    expect(proxy.agentName).toBe("solo");
  });

  it("forwards chat messages with the configured defaults", async () => {
    const client = makeClient();
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    const reply = await proxy.handleChatMessage("hello");
    expect(client.sendMessage).toHaveBeenCalledWith(
      "agent-1",
      "hello",
      "web-chat",
      "DM",
    );
    expect(reply).toBe("reply text");
  });

  it("forwards explicit room and channel overrides", async () => {
    const client = makeClient();
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    await proxy.handleChatMessage("hello", "room-9", "GROUP");
    expect(client.sendMessage).toHaveBeenCalledWith(
      "agent-1",
      "hello",
      "room-9",
      "GROUP",
    );
  });

  it("yields only chunk events whose text is a string", async () => {
    const client = makeClient();
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    const chunks: string[] = [];
    for await (const chunk of proxy.handleChatMessageStream("hello")) {
      chunks.push(chunk);
    }
    expect(client.sendMessageStream).toHaveBeenCalledWith(
      "agent-1",
      "hello",
      "web-chat",
      "DM",
    );
    expect(chunks).toEqual(["a", "b"]);
  });

  it("propagates stream errors from the client", async () => {
    const client = makeClient();
    client.sendMessageStream = vi.fn(async function* () {
      throw new Error("stream broke");
    });
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    const collect = async () => {
      const out: string[] = [];
      for await (const chunk of proxy.handleChatMessageStream("hello")) {
        out.push(chunk);
      }
      return out;
    };
    await expect(collect()).rejects.toThrow("stream broke");
  });

  it("reports the agent status from the cloud client", async () => {
    const client = makeClient();
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    const status = await proxy.getStatus();
    expect(client.getAgent).toHaveBeenCalledWith("agent-1");
    expect(status).toEqual({ state: "online", agentName: "solo" });
  });

  it("surfaces getAgent failures instead of swallowing them", async () => {
    const client = makeClient();
    client.getAgent = vi.fn(async () => {
      throw new Error("sandbox unreachable");
    });
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    await expect(proxy.getStatus()).rejects.toThrow("sandbox unreachable");
  });

  it("reports alive when the heartbeat succeeds", async () => {
    const client = makeClient();
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    await expect(proxy.isAlive()).resolves.toBe(true);
  });

  it("degrades to false when the heartbeat fails", async () => {
    const client = makeClient();
    client.heartbeat = vi.fn(async () => {
      throw new Error("timeout");
    });
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    await expect(proxy.isAlive()).resolves.toBe(false);
  });

  it("does not throw when heartbeat rejects with a non-Error value", async () => {
    const client = makeClient();
    client.heartbeat = vi.fn(async () => {
      throw "raw rejection";
    });
    const proxy = new CloudRuntimeProxy(client as never, "agent-1", "solo");
    await expect(proxy.isAlive()).resolves.toBe(false);
  });
});
