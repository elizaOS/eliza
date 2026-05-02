import { afterEach, describe, expect, it, vi } from "vitest";
import { startCallbackServer } from "./callback-server";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("startCallbackServer", () => {
  it("routes a webhook to the matching account and validates that account's API key", async () => {
    const onMessage = vi.fn();
    const server = await startCallbackServer({
      port: 0,
      accounts: [
        { accountId: "main", apiKey: "main-key" },
        { accountId: "secondary", apiKey: "secondary-key" },
      ],
      onMessage,
    });
    servers.push(server);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/webhook/wechat/secondary`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "secondary-key",
        },
        body: JSON.stringify({
          type: 60001,
          sender: "wxid-alice",
          recipient: "wxid-agent",
          content: "hello",
          timestamp: 123,
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(
      "secondary",
      expect.objectContaining({
        sender: "wxid-alice",
        content: "hello",
      }),
    );
  });

  it("rejects requests signed with another account's API key", async () => {
    const onMessage = vi.fn();
    const server = await startCallbackServer({
      port: 0,
      accounts: [
        { accountId: "main", apiKey: "main-key" },
        { accountId: "secondary", apiKey: "secondary-key" },
      ],
      onMessage,
    });
    servers.push(server);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/webhook/wechat/secondary`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "main-key",
        },
        body: JSON.stringify({
          type: 60001,
          sender: "wxid-alice",
          recipient: "wxid-agent",
          content: "hello",
          timestamp: 123,
        }),
      },
    );

    expect(response.status).toBe(401);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("rejects oversized webhook payloads", async () => {
    const onMessage = vi.fn();
    const server = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "main-key" }],
      maxBodyBytes: 64,
      onMessage,
    });
    servers.push(server);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/webhook/wechat/main`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": "main-key",
        },
        body: JSON.stringify({
          type: 60001,
          sender: "wxid-alice",
          recipient: "wxid-agent",
          content: "x".repeat(512),
          timestamp: 123,
        }),
      },
    );

    expect(response.status).toBe(413);
    expect(onMessage).not.toHaveBeenCalled();
  });

  it("maps voice message type correctly", async () => {
    const onMessage = vi.fn();
    const server = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key" }],
      onMessage,
    });
    servers.push(server);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/webhook/wechat/main`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "key" },
        body: JSON.stringify({
          data: {
            type: 60003,
            sender: "wxid-alice",
            recipient: "wxid-agent",
            content: "",
            timestamp: 456,
            mediaUrl: "https://example.com/voice.amr",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(
      "main",
      expect.objectContaining({
        type: "voice",
        imageUrl: "https://example.com/voice.amr",
      }),
    );
  });

  it("maps group video message type correctly", async () => {
    const onMessage = vi.fn();
    const server = await startCallbackServer({
      port: 0,
      accounts: [{ accountId: "main", apiKey: "key" }],
      onMessage,
    });
    servers.push(server);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/webhook/wechat/main`,
      {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": "key" },
        body: JSON.stringify({
          data: {
            type: 80004,
            sender: "room@chatroom",
            recipient: "wxid-agent",
            content: "",
            timestamp: 789,
            mediaUrl: "https://example.com/video.mp4",
          },
        }),
      },
    );

    expect(response.status).toBe(200);
    expect(onMessage).toHaveBeenCalledWith(
      "main",
      expect.objectContaining({
        type: "video",
        imageUrl: "https://example.com/video.mp4",
      }),
    );
  });
});
