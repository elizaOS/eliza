/**
 * Process-level BlueBubbles relay verification with real HTTP boundaries and
 * deterministic Cloud/BlueBubbles substitutes; no Apple account is required.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { createServer } from "node:net";
import { resolve } from "node:path";

const childProcesses: Bun.Subprocess[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) child.kill();
  for (const server of servers.splice(0)) await server.stop(true);
});

async function unusedPort(): Promise<number> {
  return await new Promise((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a local relay port"));
        return;
      }
      server.close((error) =>
        error ? reject(error) : resolvePort(address.port),
      );
    });
  });
}

async function waitForRelay(url: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.status === 404) return;
    } catch {
      // error-policy:J5 the next bounded poll observes the same startup state.
    }
    await Bun.sleep(50);
  }
  throw new Error("BlueBubbles relay did not start within 10 seconds");
}

describe("registered BlueBubbles local bridge E2E", () => {
  test("forwards with the device token and sends the bound agent reply", async () => {
    const cloudRequests: Array<{
      headers: Headers;
      body: Record<string, unknown>;
    }> = [];
    const blueBubblesSends: Array<Record<string, unknown>> = [];
    const blueBubblesWebhookCreates: Array<Record<string, unknown>> = [];
    let retryGuidFailuresRemaining = 1;

    const cloud = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        cloudRequests.push({
          headers: request.headers,
          body,
        });
        const data = body.data as Record<string, unknown> | undefined;
        if (data?.guid === "inbound-retry" && retryGuidFailuresRemaining > 0) {
          retryGuidFailuresRemaining -= 1;
          return Response.json(
            { success: false, reason: "temporary_failure" },
            { status: 503 },
          );
        }
        return Response.json({
          success: true,
          handled: true,
          replyText: "verified agent response",
          agentId: "agent-registered",
          organizationId: "org-registered",
          userId: "user-registered",
        });
      },
    });
    servers.push(cloud);

    const blueBubbles = Bun.serve({
      port: 0,
      async fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/api/v1/server/info") {
          return Response.json({
            status: 200,
            data: { server_version: "test", private_api: false },
          });
        }
        if (url.pathname === "/api/v1/webhook" && request.method === "GET") {
          return Response.json({ status: 200, data: [] });
        }
        if (url.pathname === "/api/v1/webhook" && request.method === "POST") {
          const body = (await request.json()) as Record<string, unknown>;
          blueBubblesWebhookCreates.push(body);
          return Response.json({
            status: 200,
            data: { id: 1, ...body },
          });
        }
        if (url.pathname === "/api/v1/message/text") {
          blueBubblesSends.push(
            (await request.json()) as Record<string, unknown>,
          );
          return Response.json({ status: 200, data: { guid: "outbound-1" } });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    servers.push(blueBubbles);

    const relayPort = await unusedPort();
    const bridgeId = "bb-11111111-1111-4111-8111-111111111111";
    const token = `bbg_${"a".repeat(64)}`;
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        resolve("packages/cloud/scripts/bluebubbles-local-bridge.ts"),
      ],
      {
        cwd: resolve("."),
        env: {
          ...process.env,
          BLUEBUBBLES_BRIDGE_PORT: String(relayPort),
          BLUEBUBBLES_SERVER_URL: `http://127.0.0.1:${blueBubbles.port}`,
          BLUEBUBBLES_PASSWORD: "test-password",
          BLUEBUBBLES_GATEWAY_TOKEN: token,
          BLUEBUBBLES_BRIDGE_ID: bridgeId,
          BLUEBUBBLES_GATEWAY_PHONE_NUMBER: "+14155550123",
          ELIZA_CLOUD_BLUEBUBBLES_URL: `http://127.0.0.1:${cloud.port}/api/webhooks/bluebubbles/${bridgeId}`,
          BLUEBUBBLES_AUTO_START: "false",
          BLUEBUBBLES_SEND_METHOD: "apple-script",
        },
        stdout: "ignore",
        stderr: "ignore",
      },
    );
    childProcesses.push(child);
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    await waitForRelay(`${relayUrl}/not-found`);

    const response = await fetch(`${relayUrl}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "new-message",
        data: {
          guid: "inbound-1",
          text: "hello registered agent",
          isFromMe: false,
          handle: { address: "+14155550999", service: "iMessage" },
          chats: [
            {
              guid: "iMessage;-;+14155550999",
              chatIdentifier: "+14155550999",
            },
          ],
        },
      }),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      success: true,
      handled: true,
      agentId: "agent-registered",
      organizationId: "org-registered",
      userId: "user-registered",
      replied: true,
      replyQueued: false,
    });

    expect(cloudRequests).toHaveLength(1);
    expect(cloudRequests[0]?.headers.get("authorization")).toBe(
      `Bearer ${token}`,
    );
    expect(cloudRequests[0]?.headers.get("x-eliza-bridge")).toBe(bridgeId);
    expect(cloudRequests[0]?.body).toMatchObject({
      data: {
        guid: "inbound-1",
        metadata: {
          localPhoneNumber: "+14155550123",
        },
      },
    });
    expect(blueBubblesSends).toEqual([
      expect.objectContaining({
        chatGuid: "iMessage;-;+14155550999",
        message: "verified agent response",
        method: "apple-script",
      }),
    ]);
    const inboundEventsResponse = await fetch(
      `${relayUrl}/inbound-events?sender=${encodeURIComponent("+14155550999")}&marker=hello%20registered`,
    );
    expect(inboundEventsResponse.status).toBe(200);
    await expect(inboundEventsResponse.json()).resolves.toMatchObject({
      count: 1,
      events: [
        {
          messageId: "inbound-1",
          sender: "+14155550999",
          textPreview: "hello registered agent",
          handled: true,
          agentId: "agent-registered",
          organizationId: "org-registered",
          userId: "user-registered",
          replied: true,
          replyQueued: false,
        },
      ],
    });
    const webhookDeadline = Date.now() + 2_000;
    while (
      blueBubblesWebhookCreates.length === 0 &&
      Date.now() < webhookDeadline
    ) {
      await Bun.sleep(25);
    }
    expect(blueBubblesWebhookCreates).toEqual([
      {
        url: `http://127.0.0.1:${relayPort}/webhooks/bluebubbles`,
        events: ["new-message", "updated-message"],
      },
    ]);

    const retryPayload = {
      type: "new-message",
      data: {
        guid: "inbound-retry",
        text: "retry this exact message",
        isFromMe: false,
        handle: { address: "+14155550888", service: "iMessage" },
        chats: [
          {
            guid: "iMessage;-;+14155550888",
            chatIdentifier: "+14155550888",
          },
        ],
      },
    };
    const failed = await fetch(`${relayUrl}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(retryPayload),
    });
    expect(failed.status).toBe(500);

    const retried = await fetch(`${relayUrl}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(retryPayload),
    });
    expect(retried.status).toBe(200);
    await expect(retried.json()).resolves.toMatchObject({
      success: true,
      replied: true,
      agentId: "agent-registered",
    });
    expect(
      cloudRequests.filter(
        (entry) =>
          (entry.body.data as Record<string, unknown> | undefined)?.guid ===
          "inbound-retry",
      ),
    ).toHaveLength(2);
    expect(blueBubblesSends.at(-1)).toMatchObject({
      chatGuid: "iMessage;-;+14155550888",
      message: "verified agent response",
    });
  }, 15_000);
});
