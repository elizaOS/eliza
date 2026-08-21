/**
 * Process-level BlueBubbles relay verification with real HTTP boundaries and
 * deterministic Cloud/BlueBubbles substitutes; no Apple account is required.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const childProcesses: Bun.Subprocess[] = [];
const servers: ReturnType<typeof Bun.serve>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const child of childProcesses.splice(0)) child.kill();
  for (const server of servers.splice(0)) await server.stop(true);
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { force: true, recursive: true });
  }
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

type RelayOutput = { stdout: string; stderr: string };

function redactRelayOutput(value: string): string {
  return value
    .replace(/bbg_[A-Za-z0-9_-]+/g, "<redacted-token>")
    .replace(/\+[1-9]\d{7,14}/g, "<redacted-phone>")
    .slice(-4_000);
}

function captureRelayOutput(
  stream: ReadableStream<Uint8Array>,
  output: RelayOutput,
  key: keyof RelayOutput,
): void {
  void (async () => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        output[key] = redactRelayOutput(
          `${output[key]}${decoder.decode(chunk.value, { stream: true })}`,
        );
      }
      output[key] = redactRelayOutput(`${output[key]}${decoder.decode()}`);
    } catch {
      // error-policy:J5 readiness observes the same child exit; log capture is
      // diagnostic only and must not create an unhandled rejection.
    }
  })();
}

async function waitForRelay(
  url: string,
  child: Bun.Subprocess,
  output: RelayOutput,
): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(
        `BlueBubbles relay exited before readiness (code ${child.exitCode})\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
      );
    }
    try {
      const response = await fetch(url);
      if (response.status === 404) return;
    } catch {
      // error-policy:J5 the next bounded poll observes the same startup state.
    }
    await Bun.sleep(50);
  }
  throw new Error(
    `BlueBubbles relay did not start within 10 seconds\nstdout:\n${output.stdout}\nstderr:\n${output.stderr}`,
  );
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
    let pendingDeliveryFailuresRemaining = 2;

    const cloud = Bun.serve({
      port: 0,
      async fetch(request) {
        const body = (await request.json()) as Record<string, unknown>;
        cloudRequests.push({
          headers: request.headers,
          body,
        });
        const data = body.data as Record<string, unknown> | undefined;
        if (data?.isFromMe === true) {
          return Response.json({
            success: true,
            skipped: "outbound_message",
          });
        }
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
        if (
          request.method === "GET" &&
          url.pathname.startsWith("/api/v1/message/") &&
          url.searchParams.get("with") === "chats"
        ) {
          const messageGuid = decodeURIComponent(
            url.pathname.slice("/api/v1/message/".length),
          );
          if (
            [
              "inbound-1",
              "inbound-retry",
              "inbound-pending-delivery",
              "cross-number-inbound",
            ].includes(messageGuid)
          ) {
            return Response.json({
              status: 200,
              data: {
                guid: messageGuid,
                chats: [{ lastAddressedHandle: "+14155550123" }],
              },
            });
          }
        }
        if (url.pathname === "/api/v1/message/text") {
          const send = (await request.json()) as Record<string, unknown>;
          blueBubblesSends.push(send);
          if (
            send.chatGuid === "iMessage;-;+14155550889" &&
            pendingDeliveryFailuresRemaining > 0
          ) {
            pendingDeliveryFailuresRemaining -= 1;
            return Response.json(
              {
                error:
                  "<script>password=secret /private/BlueBubbles.swift:42</script>",
              },
              { status: 500 },
            );
          }
          return Response.json({ status: 200, data: { guid: "outbound-1" } });
        }
        return Response.json({ error: "not found" }, { status: 404 });
      },
    });
    servers.push(blueBubbles);

    const relayPort = await unusedPort();
    const temporaryDirectory = await mkdtemp(
      join(tmpdir(), "eliza-bluebubbles-loopback-"),
    );
    temporaryDirectories.push(temporaryDirectory);
    const bridgeId = "bb-11111111-1111-4111-8111-111111111111";
    const token = `bbg_${"a".repeat(64)}`;
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        join(import.meta.dir, "bluebubbles-local-bridge.ts"),
      ],
      {
        cwd: import.meta.dir,
        env: {
          ...process.env,
          BLUEBUBBLES_BRIDGE_PORT: String(relayPort),
          BLUEBUBBLES_SERVER_URL: `http://127.0.0.1:${blueBubbles.port}`,
          BLUEBUBBLES_PASSWORD: "test-password",
          BLUEBUBBLES_GATEWAY_TOKEN: token,
          BLUEBUBBLES_BRIDGE_ID: bridgeId,
          BLUEBUBBLES_GATEWAY_PHONE_NUMBER: "+14155550123",
          BLUEBUBBLES_OUTBOUND_VALIDATION_PATH: join(
            temporaryDirectory,
            "outbound-validation.json",
          ),
          BLUEBUBBLES_PENDING_REPLIES_PATH: join(
            temporaryDirectory,
            "pending-replies.json",
          ),
          ELIZA_CLOUD_BLUEBUBBLES_URL: `http://127.0.0.1:${cloud.port}/api/webhooks/bluebubbles/${bridgeId}`,
          BLUEBUBBLES_AUTO_START: "false",
          BLUEBUBBLES_SEND_METHOD: "apple-script",
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    childProcesses.push(child);
    const relayOutput: RelayOutput = { stdout: "", stderr: "" };
    captureRelayOutput(child.stdout, relayOutput, "stdout");
    captureRelayOutput(child.stderr, relayOutput, "stderr");
    const relayUrl = `http://127.0.0.1:${relayPort}`;
    await waitForRelay(`${relayUrl}/not-found`, child, relayOutput);

    const malformed = await fetch(`${relayUrl}/outbound/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"message":"<script>private/path.ts:42</script>",',
    });
    expect(malformed.status).toBe(500);
    await expect(malformed.json()).resolves.toEqual({
      error: "BlueBubbles bridge request failed",
    });

    const personalIdentityResponse = await fetch(
      `${relayUrl}/webhooks/bluebubbles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "new-message",
          data: {
            guid: "personal-inbound",
            text: "private personal message",
            isFromMe: false,
            handle: { address: "+14155550001", service: "iMessage" },
            chats: [
              {
                guid: "iMessage;-;+14155550001",
                chatIdentifier: "+14155550001",
                lastAddressedHandle: "+14155550002",
              },
            ],
          },
        }),
      },
    );
    expect(personalIdentityResponse.status).toBe(200);
    await expect(personalIdentityResponse.json()).resolves.toMatchObject({
      success: true,
      skipped: "gateway_target_mismatch",
      replied: false,
      replyQueued: false,
    });
    expect(cloudRequests).toHaveLength(0);
    expect(blueBubblesSends).toHaveLength(0);

    const unverifiedIdentityResponse = await fetch(
      `${relayUrl}/webhooks/bluebubbles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "new-message",
          data: {
            guid: "unverified-inbound",
            text: "message with no receiving identity",
            isFromMe: false,
            handle: { address: "+14155550003", service: "iMessage" },
            chats: [
              {
                guid: "iMessage;-;+14155550003",
                chatIdentifier: "+14155550003",
              },
            ],
          },
        }),
      },
    );
    expect(unverifiedIdentityResponse.status).toBe(200);
    await expect(unverifiedIdentityResponse.json()).resolves.toMatchObject({
      success: true,
      skipped: "gateway_target_unverified",
      replied: false,
      replyQueued: false,
    });
    expect(cloudRequests).toHaveLength(0);
    expect(blueBubblesSends).toHaveLength(0);

    const gatewaySelfMessageResponse = await fetch(
      `${relayUrl}/webhooks/bluebubbles`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "new-message",
          data: {
            guid: "gateway-self-message",
            text: "message sent from the gateway to itself",
            isFromMe: false,
            handle: { address: "+14155550123", service: "iMessage" },
            chats: [
              {
                guid: "iMessage;-;+14155550123",
                chatIdentifier: "+14155550123",
                lastAddressedHandle: "+14155550123",
              },
            ],
          },
        }),
      },
    );
    expect(gatewaySelfMessageResponse.status).toBe(200);
    await expect(gatewaySelfMessageResponse.json()).resolves.toMatchObject({
      success: true,
      skipped: "gateway_self_message",
      replied: false,
      replyQueued: false,
    });
    expect(cloudRequests).toHaveLength(0);
    expect(blueBubblesSends).toHaveLength(0);

    const response = await fetch(`${relayUrl}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "new-message",
        data: {
          guid: "inbound-1",
          text: "hello registered agent",
          isFromMe: false,
          loopbackNormalized: false,
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
          eventType: "new-message",
          sender: "+14155550999",
          textPreview: "hello registered agent",
          isFromMe: false,
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
        events: ["new-message"],
      },
    ]);

    const validationResponse = await fetch(`${relayUrl}/outbound/validate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        recipient: "+14155550777",
        message: "direct validation",
        method: "apple-script",
      }),
    });
    expect(validationResponse.status).toBe(200);
    await expect(validationResponse.json()).resolves.toMatchObject({
      ok: true,
      validation: {
        recipient: "+14155550777",
        method: "apple-script",
      },
    });
    expect(blueBubblesSends.at(-1)).toMatchObject({
      chatGuid: "iMessage;-;+14155550777",
      message: "direct validation",
      method: "apple-script",
    });

    const selfValidationResponse = await fetch(
      `${relayUrl}/outbound/validate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          recipient: "+14155550123",
          message: "must never send",
          method: "apple-script",
        }),
      },
    );
    expect(selfValidationResponse.status).toBe(500);
    await expect(selfValidationResponse.json()).resolves.toMatchObject({
      error: "BlueBubbles bridge request failed",
    });
    expect(blueBubblesSends).toHaveLength(2);

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

    const queued = await fetch(`${relayUrl}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "new-message",
        data: {
          guid: "inbound-pending-delivery",
          text: "queue this reply",
          isFromMe: false,
          handle: { address: "+14155550889", service: "iMessage" },
          chats: [
            {
              guid: "iMessage;-;+14155550889",
              chatIdentifier: "+14155550889",
            },
          ],
        },
      }),
    });
    expect(queued.status).toBe(200);
    await expect(queued.json()).resolves.toMatchObject({
      success: true,
      replied: false,
      replyQueued: true,
      sendError: "BlueBubbles reply delivery failed",
    });

    const pendingBeforeRetry = await fetch(`${relayUrl}/pending-replies`);
    const pendingBeforeRetryBody = await pendingBeforeRetry.json();
    expect(pendingBeforeRetryBody).toMatchObject({
      count: 1,
      replies: [
        {
          sourceMessageId: "inbound-pending-delivery",
          attempts: 0,
          lastError: "BlueBubbles reply delivery failed",
        },
      ],
    });
    expect(JSON.stringify(pendingBeforeRetryBody)).not.toContain(
      "BlueBubbles.swift",
    );

    const retryFailedDelivery = await fetch(
      `${relayUrl}/pending-replies/retry`,
      { method: "POST" },
    );
    const retryFailedBody = await retryFailedDelivery.json();
    expect(retryFailedBody).toMatchObject({
      sent: [],
      remaining: 1,
      failed: [
        {
          error: "BlueBubbles reply delivery failed",
        },
      ],
    });
    expect(JSON.stringify(retryFailedBody)).not.toContain("BlueBubbles.swift");

    const pendingAfterRetry = await fetch(`${relayUrl}/pending-replies`);
    const pendingAfterRetryBody = await pendingAfterRetry.json();
    expect(pendingAfterRetryBody).toMatchObject({
      count: 1,
      replies: [
        {
          attempts: 1,
          lastError: "BlueBubbles reply delivery failed",
        },
      ],
    });
    expect(JSON.stringify(pendingAfterRetryBody)).not.toContain(
      "BlueBubbles.swift",
    );

    const outboundEvent = await fetch(`${relayUrl}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "new-message",
        data: {
          guid: "outbound-self-test",
          text: "self-sent diagnostic",
          isFromMe: true,
          handle: { address: "+14155550123", service: "iMessage" },
          chats: [
            {
              guid: "iMessage;-;+14155550123",
              chatIdentifier: "+14155550123",
            },
          ],
        },
      }),
    });
    expect(outboundEvent.status).toBe(200);
    await expect(outboundEvent.json()).resolves.toMatchObject({
      success: true,
      skipped: "outbound_message",
      replied: false,
      replyQueued: false,
    });

    const outboundEvents = await fetch(
      `${relayUrl}/inbound-events?marker=self-sent%20diagnostic`,
    );
    await expect(outboundEvents.json()).resolves.toMatchObject({
      count: 1,
      events: [
        {
          eventType: "new-message",
          messageId: "outbound-self-test",
          isFromMe: true,
          loopbackNormalized: false,
          skipped: "outbound_message",
          replied: false,
          replyQueued: false,
        },
      ],
    });

    const crossNumberInbound = await fetch(`${relayUrl}/webhooks/bluebubbles`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        type: "new-message",
        data: {
          guid: "cross-number-inbound",
          text: "same Apple Account inbound",
          isFromMe: true,
          handle: { address: "+14155550123", service: "iMessage" },
          chats: [
            {
              guid: "any;-;+14155550123",
              chatIdentifier: "+14155550123",
            },
          ],
        },
      }),
    });
    expect(crossNumberInbound.status).toBe(200);
    await expect(crossNumberInbound.json()).resolves.toMatchObject({
      success: true,
      skipped: "outbound_message",
      replied: false,
      replyQueued: false,
    });
    expect(
      cloudRequests.filter(
        (entry) =>
          (entry.body.data as Record<string, unknown> | undefined)?.guid ===
          "cross-number-inbound",
      ),
    ).toHaveLength(0);

    const crossNumberEvents = await fetch(
      `${relayUrl}/inbound-events?marker=same%20Apple%20Account`,
    );
    await expect(crossNumberEvents.json()).resolves.toMatchObject({
      count: 1,
      events: [
        {
          messageId: "cross-number-inbound",
          sender: "+14155550123",
          isFromMe: true,
          loopbackNormalized: false,
          skipped: "outbound_message",
          replied: false,
          replyQueued: false,
        },
      ],
    });
  }, 180_000);
});
