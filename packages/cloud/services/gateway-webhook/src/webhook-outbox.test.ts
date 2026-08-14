/** Proves crash recovery and no-replay ownership against a real Redis command surface. */
import { describe, expect, test } from "bun:test";
import type { ChatEvent } from "./adapters/types";
import { MemoryRedisAdapter as TestRedis } from "./redis";
import {
  claimDueWebhookDeliveries,
  claimWebhookDelivery,
  completeWebhookDelivery,
  enqueueWebhookDelivery,
  markWebhookSideEffectStarted,
} from "./webhook-outbox";

function event(messageId: string): ChatEvent {
  return {
    platform: "twilio",
    messageId,
    chatId: "+15551234567",
    senderId: "+15551234567",
    text: "hello",
    rawPayload: {},
  };
}

describe("durable webhook delivery outbox", () => {
  test("atomically deduplicates and completes one delivery", async () => {
    const redis = new TestRedis();
    const dedupKey = "webhook:twilio:message:SM_atomic";
    const job = await enqueueWebhookDelivery(redis, {
      dedupKey,
      platform: "twilio",
      project: "eliza-app",
      event: event("SM_atomic"),
    });

    expect(job).not.toBeNull();
    expect(
      await enqueueWebhookDelivery(redis, {
        dedupKey,
        platform: "twilio",
        project: "eliza-app",
        event: event("SM_atomic"),
      }),
    ).toBeNull();

    const claimed = await claimWebhookDelivery(
      redis,
      job?.jobKey ?? "",
      "worker-a",
    );
    expect(claimed?.job.event.messageId).toBe("SM_atomic");
    if (!claimed) throw new Error("expected claimed delivery");
    await markWebhookSideEffectStarted(redis, claimed, "provider_egress");
    expect(await redis.get<string>(dedupKey)).toBe("side_effect_started");
    await completeWebhookDelivery(redis, claimed);
    expect(await redis.get<string>(dedupKey)).toBe("delivered");
    expect(await redis.get(claimed.job.jobKey)).toBeNull();
  });

  test("reclaims queued work after a worker dies before egress", async () => {
    const redis = new TestRedis();
    const job = await enqueueWebhookDelivery(redis, {
      dedupKey: "webhook:twilio:message:SM_crash",
      platform: "twilio",
      project: "eliza-app",
      event: event("SM_crash"),
    });
    if (!job) throw new Error("expected queued delivery");

    expect(
      await claimWebhookDelivery(redis, job.jobKey, "dead-worker"),
    ).not.toBeNull();
    await redis.del(`${job.jobKey}:lease`);

    const recovered = await claimDueWebhookDeliveries(
      redis,
      "recovery-worker",
      10,
    );
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.job.event.messageId).toBe("SM_crash");
    if (!recovered[0]) throw new Error("expected recovered delivery");
    await completeWebhookDelivery(redis, recovered[0]);
    expect(await redis.get<string>(job.dedupKey)).toBe("delivered");
  });

  test("never reclaims an ambiguous external side effect", async () => {
    const redis = new TestRedis();
    const job = await enqueueWebhookDelivery(redis, {
      dedupKey: "webhook:twilio:message:SM_uncertain",
      platform: "twilio",
      project: "eliza-app",
      event: event("SM_uncertain"),
    });
    if (!job) throw new Error("expected queued delivery");
    const claimed = await claimWebhookDelivery(
      redis,
      job.jobKey,
      "crashing-worker",
    );
    if (!claimed) throw new Error("expected claimed delivery");

    await markWebhookSideEffectStarted(redis, claimed, "provider_egress");
    await redis.del(`${job.jobKey}:lease`);
    expect(
      await claimDueWebhookDeliveries(redis, "recovery-worker", 10),
    ).toEqual([]);
    expect(await redis.get<string>(job.dedupKey)).toBe("side_effect_started");
    expect(await redis.get(job.jobKey)).toMatchObject({
      state: "side_effect_started",
      sideEffect: "provider_egress",
    });
  });
});
