/**
 * Pins the in-memory idempotent webhook recorder contract: the first
 * (provider, eventId) pair records, repeats are suppressed, and providers are
 * isolated from one another.
 */
import { describe, expect, test } from "bun:test";
import { createInMemoryIdempotentWebhookRecorder } from "./idempotent-webhook-recorder";

describe("createInMemoryIdempotentWebhookRecorder", () => {
  test("records a first-seen event as new", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    expect(await recorder.recordIfNew("twilio", "event-1")).toBe(true);
  });

  test("rejects a repeated event for the same provider", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    await recorder.recordIfNew("twilio", "event-1");
    expect(await recorder.recordIfNew("twilio", "event-1")).toBe(false);
  });

  test("accepts a distinct event id for the same provider", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    await recorder.recordIfNew("twilio", "event-1");
    expect(await recorder.recordIfNew("twilio", "event-2")).toBe(true);
  });

  test("isolates providers from one another", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    await recorder.recordIfNew("twilio", "event-1");
    expect(await recorder.recordIfNew("stripe", "event-1")).toBe(true);
  });

  test("stays idempotent across repeated interleaved calls", async () => {
    const recorder = createInMemoryIdempotentWebhookRecorder();
    expect(await recorder.recordIfNew("a", "1")).toBe(true);
    expect(await recorder.recordIfNew("b", "1")).toBe(true);
    expect(await recorder.recordIfNew("a", "1")).toBe(false);
    expect(await recorder.recordIfNew("a", "2")).toBe(true);
    expect(await recorder.recordIfNew("b", "1")).toBe(false);
  });
});
