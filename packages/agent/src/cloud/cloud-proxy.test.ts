/**
 * Tests for cloud/cloud-proxy.ts — the CloudRuntimeProxy.
 *
 * Exercises:
 *   - handleChatMessage delegates to client.sendMessage
 *   - handleChatMessageStream yields text chunks
 *   - getStatus returns agent status
 *   - agentName getter
 */

import { describe, expect, it, vi } from "vitest";
import type { ElizaCloudClient } from "./bridge-client";
import { CloudRuntimeProxy } from "./cloud-proxy";

function createMockClient(
  overrides: Partial<ElizaCloudClient> = {},
): ElizaCloudClient {
  return {
    sendMessage: vi.fn().mockResolvedValue("Hello from cloud"),
    sendMessageStream: vi.fn().mockImplementation(async function* () {
      yield { type: "chunk", data: { text: "Hello " } };
      yield { type: "chunk", data: { text: "world" } };
      yield { type: "done", data: {} };
    }),
    getAgent: vi
      .fn()
      .mockResolvedValue({ id: "a1", agentName: "TestBot", status: "running" }),
    heartbeat: vi.fn().mockResolvedValue(true),
    ...overrides,
  } as unknown as ElizaCloudClient;
}

describe("CloudRuntimeProxy", () => {
  it("agentName returns the name passed at construction", () => {
    const proxy = new CloudRuntimeProxy(createMockClient(), "a1", "MyBot");
    expect(proxy.agentName).toBe("MyBot");
  });

  it("handleChatMessage delegates to client and returns text", async () => {
    const client = createMockClient();
    const proxy = new CloudRuntimeProxy(client, "a1", "Bot");

    const result = await proxy.handleChatMessage("Hi there");
    expect(result).toBe("Hello from cloud");
    expect(client.sendMessage).toHaveBeenCalledWith(
      "a1",
      "Hi there",
      "web-chat",
      "DM",
    );
  });

  it("handleChatMessage passes custom roomId", async () => {
    const client = createMockClient();
    const proxy = new CloudRuntimeProxy(client, "a1", "Bot");

    await proxy.handleChatMessage("Hi", "custom-room");
    expect(client.sendMessage).toHaveBeenCalledWith(
      "a1",
      "Hi",
      "custom-room",
      "DM",
    );
  });

  it("handleChatMessageStream yields only text chunks", async () => {
    const proxy = new CloudRuntimeProxy(createMockClient(), "a1", "Bot");

    const chunks: string[] = [];
    for await (const chunk of proxy.handleChatMessageStream(
      "Tell me something",
    )) {
      chunks.push(chunk);
    }

    // "done" events are filtered out — only text chunks yielded
    expect(chunks).toEqual(["Hello ", "world"]);
  });

  it("handleChatMessageStream skips non-text events", async () => {
    const client = createMockClient({
      sendMessageStream: vi.fn().mockImplementation(async function* () {
        yield { type: "connected", data: { agentId: "a1" } };
        yield { type: "chunk", data: { text: "hi" } };
        yield { type: "chunk", data: { count: 42 } }; // no text field
        yield { type: "done", data: {} };
      }),
    } as Partial<ElizaCloudClient>);

    const proxy = new CloudRuntimeProxy(client, "a1", "Bot");
    const chunks: string[] = [];
    for await (const chunk of proxy.handleChatMessageStream("test")) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(["hi"]);
  });

  it("getStatus returns status from cloud agent", async () => {
    const proxy = new CloudRuntimeProxy(createMockClient(), "a1", "Bot");
    const status = await proxy.getStatus();

    expect(status.state).toBe("running");
    expect(status.agentName).toBe("TestBot");
  });

  it("isAlive returns true when heartbeat succeeds", async () => {
    const proxy = new CloudRuntimeProxy(createMockClient(), "a1", "Bot");
    const alive = await proxy.isAlive();
    expect(alive).toBe(true);
  });

  it("isAlive returns false when heartbeat fails", async () => {
    const client = createMockClient({
      heartbeat: vi.fn().mockRejectedValue(new Error("timeout")),
    } as Partial<ElizaCloudClient>);

    const proxy = new CloudRuntimeProxy(client, "a1", "Bot");
    const alive = await proxy.isAlive();
    expect(alive).toBe(false);
  });
});
