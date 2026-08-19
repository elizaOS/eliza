/** Tests durable cross-channel greeting delivery and acknowledgement policy. */

import { describe, expect, mock, test } from "bun:test";
import { drainAndDeliverWebhookGreetings } from "../src/proactive-greeting-delivery";
import type { GatewayRedis } from "../src/redis";

const redis = {} as GatewayRedis;

describe("webhook proactive greeting delivery", () => {
  test("delivers Telegram and phone entries with fixed recipient fields", async () => {
    const deliveries: Array<Record<string, unknown>> = [];
    const acknowledgements: Array<{
      platform: string;
      entries: Array<{ sessionId: string; leaseId: string }>;
    }> = [];
    const report = await drainAndDeliverWebhookGreetings({
      redis,
      claim: mock(async (platform) =>
        Response.json({
          greetings: [
            {
              sessionId: `platform:${platform}:identity`,
              platformUserId:
                platform === "telegram" ? "123456" : "+14155550100",
              message: "You're connected.",
              leaseId: `lease-${platform}`,
              deliveryNonce: `nonce-${platform}`,
            },
          ],
        }),
      ),
      deliver: mock(async (request) => {
        deliveries.push((await request.json()) as Record<string, unknown>);
        return Response.json({ success: true });
      }),
      acknowledge: mock(async (platform, entries) => {
        acknowledgements.push({ platform, entries });
        return Response.json({ acknowledged: entries.length });
      }),
    });

    expect(deliveries).toEqual([
      expect.objectContaining({ platform: "telegram", chatId: "123456" }),
      expect.objectContaining({
        platform: "blooio",
        phoneNumber: "+14155550100",
      }),
      expect.objectContaining({
        platform: "twilio",
        phoneNumber: "+14155550100",
      }),
    ]);
    expect(acknowledgements).toHaveLength(3);
    expect(report).toMatchObject({
      claimed: 3,
      delivered: 3,
      acknowledged: 3,
      retainedForRetry: 0,
    });
  });

  test("acks acceptance-unknown sends but retains explicit retryable failures", async () => {
    let delivery = 0;
    const acknowledged: string[] = [];
    const report = await drainAndDeliverWebhookGreetings({
      redis,
      claim: mock(async (platform) =>
        platform === "telegram"
          ? Response.json({
              greetings: [
                {
                  sessionId: "platform:telegram:123",
                  platformUserId: "123",
                  message: "Linked.",
                  leaseId: "lease-1",
                  deliveryNonce: "nonce-1",
                },
                {
                  sessionId: "platform:telegram:456",
                  platformUserId: "456",
                  message: "Linked.",
                  leaseId: "lease-2",
                  deliveryNonce: "nonce-2",
                },
              ],
            })
          : Response.json({ greetings: [] }),
      ),
      deliver: mock(async () => {
        delivery += 1;
        return delivery === 1
          ? Response.json({ acceptance: "unknown" }, { status: 202 })
          : Response.json({ retryable: true }, { status: 503 });
      }),
      acknowledge: mock(async (_platform, entries) => {
        acknowledged.push(...entries.map((entry) => entry.sessionId));
        return Response.json({ acknowledged: entries.length });
      }),
    });

    expect(acknowledged).toEqual(["platform:telegram:123"]);
    expect(report.delivered).toBe(1);
    expect(report.retainedForRetry).toBe(1);
  });

  test("does not claim delivery when cloud authentication needs refresh", async () => {
    const deliver = mock(async () => Response.json({ success: true }));
    const report = await drainAndDeliverWebhookGreetings({
      redis,
      claim: mock(async () => new Response(null, { status: 401 })),
      deliver,
      acknowledge: mock(async () => Response.json({ acknowledged: 0 })),
    });
    expect(report.authRefreshNeeded).toBe(true);
    expect(deliver).not.toHaveBeenCalled();
  });

  test("retries an unacknowledged lifecycle notice and acknowledges only the success", async () => {
    const greeting = {
      sessionId: "lifecycle:workspace-ready-source-1",
      platformUserId: "+14155550100",
      message: "Your personal workspace is ready.",
      leaseId: "lease-retry",
      deliveryNonce: "lifecycle-retry",
    };
    let attempt = 0;
    const acknowledge = mock(async (_platform, entries) =>
      Response.json({ acknowledged: entries.length }),
    );
    const run = () =>
      drainAndDeliverWebhookGreetings({
        redis,
        claim: mock(async (platform) =>
          Response.json({ greetings: platform === "twilio" ? [greeting] : [] }),
        ),
        deliver: mock(async () => {
          attempt += 1;
          return attempt === 1
            ? Response.json({ retryable: true }, { status: 503 })
            : Response.json({ success: true });
        }),
        acknowledge,
      });

    expect(await run()).toMatchObject({ retainedForRetry: 1, acknowledged: 0 });
    expect(acknowledge).not.toHaveBeenCalled();
    expect(await run()).toMatchObject({ delivered: 1, acknowledged: 1 });
    expect(acknowledge).toHaveBeenCalledTimes(1);
  });
});
