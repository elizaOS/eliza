import { describe, expect, test } from "bun:test";

import { createInMemoryIdempotentWebhookRecorder } from "@/lib/services/idempotent-webhook-recorder";

describe("idempotent-webhook-recorder", () => {
  test("first record returns true, replay returns false", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    expect(await recorder.recordIfNew("stripe", "evt_1")).toBe(true);
    expect(await recorder.recordIfNew("stripe", "evt_1")).toBe(false);
    expect(await recorder.recordIfNew("stripe", "evt_1")).toBe(false);
  });

  test("distinct event ids on the same provider are independent", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    expect(await recorder.recordIfNew("stripe", "evt_1")).toBe(true);
    expect(await recorder.recordIfNew("stripe", "evt_2")).toBe(true);
    expect(await recorder.recordIfNew("stripe", "evt_2")).toBe(false);
  });

  test("distinct providers do not collide on the same event id", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    expect(await recorder.recordIfNew("stripe", "evt_shared")).toBe(true);
    expect(await recorder.recordIfNew("oxapay", "evt_shared")).toBe(true);
    expect(await recorder.recordIfNew("x402", "evt_shared")).toBe(true);

    expect(await recorder.recordIfNew("stripe", "evt_shared")).toBe(false);
    expect(await recorder.recordIfNew("oxapay", "evt_shared")).toBe(false);
    expect(await recorder.recordIfNew("x402", "evt_shared")).toBe(false);
  });

  test("recorder instances are independent", async () => {
    const a = createInMemoryIdempotentWebhookRecorder();
    const b = createInMemoryIdempotentWebhookRecorder();
    expect(await a.recordIfNew("stripe", "evt_x")).toBe(true);
    expect(await b.recordIfNew("stripe", "evt_x")).toBe(true);
    expect(await a.recordIfNew("stripe", "evt_x")).toBe(false);
    expect(await b.recordIfNew("stripe", "evt_x")).toBe(false);
  });
});
