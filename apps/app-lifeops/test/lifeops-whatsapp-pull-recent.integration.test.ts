/**
 * Integration test: WhatsApp `pullWhatsAppRecent()` periodic read.
 *
 * Tests the peek-based pull method that mirrors the webhook parser without
 * draining the buffer. No live WhatsApp credentials are required — all tests
 * use the in-process inbound buffer directly.
 */

import { mkdir, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LifeOpsService } from "../src/lifeops/service.js";
import {
  drainWhatsAppInboundBuffer,
  parseAndBufferWhatsAppWebhookMessages,
} from "../src/lifeops/whatsapp-client.js";
import { createLifeOpsTestRuntime } from "./helpers/runtime.ts";

function makeWebhookPayload(
  messages: Array<{ id: string; from: string; body: string }>,
) {
  return {
    entry: [
      {
        changes: [
          {
            value: {
              metadata: {
                display_phone_number: "+1 555 000 1111",
                phone_number_id: "phone-pull",
              },
              contacts: messages.map((m) => ({
                profile: { name: `WhatsApp ${m.from}` },
                wa_id: m.from,
              })),
              messages: messages.map((m) => ({
                id: m.id,
                from: m.from,
                timestamp: String(Math.floor(Date.now() / 1000)),
                type: "text",
                text: { body: m.body },
              })),
            },
          },
        ],
      },
    ],
  };
}

describe("Integration: WhatsApp pullWhatsAppRecent", () => {
  let oauthDir: string;
  let prevOAuthDir: string | undefined;
  let prevStateDir: string | undefined;
  let prevDisableProactive: string | undefined;
  let runtime: Awaited<ReturnType<typeof createLifeOpsTestRuntime>> | undefined;

  beforeEach(async () => {
    // Drain any leftovers from a previous test.
    drainWhatsAppInboundBuffer();

    oauthDir = await mkdtemp(path.join(os.tmpdir(), "lifeops-whatsapp-pull-"));
    prevOAuthDir = process.env.ELIZA_OAUTH_DIR;
    prevStateDir = process.env.ELIZA_STATE_DIR;
    prevDisableProactive = process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    process.env.ELIZA_OAUTH_DIR = oauthDir;
    process.env.ELIZA_STATE_DIR = path.join(oauthDir, "state");
    await mkdir(process.env.ELIZA_STATE_DIR, { recursive: true });
    process.env.ELIZA_DISABLE_PROACTIVE_AGENT = "1";
  });

  afterEach(async () => {
    drainWhatsAppInboundBuffer();
    if (runtime) {
      await runtime.cleanup();
      runtime = undefined;
    }
    if (prevOAuthDir === undefined) delete process.env.ELIZA_OAUTH_DIR;
    else process.env.ELIZA_OAUTH_DIR = prevOAuthDir;
    if (prevStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
    else process.env.ELIZA_STATE_DIR = prevStateDir;
    if (prevDisableProactive === undefined)
      delete process.env.ELIZA_DISABLE_PROACTIVE_AGENT;
    else process.env.ELIZA_DISABLE_PROACTIVE_AGENT = prevDisableProactive;
    await rm(oauthDir, { recursive: true, force: true });
  });

  it("returns empty when no messages have been ingested", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);
    const result = service.pullWhatsAppRecent();
    expect(result.count).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("returns buffered messages without draining the buffer", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);

    const payload = makeWebhookPayload([
      { id: "wamid.pull.001", from: "+15551110001", body: "First" },
      { id: "wamid.pull.002", from: "+15551110002", body: "Second" },
    ]);
    await service.ingestWhatsAppWebhook(payload);

    const first = service.pullWhatsAppRecent();
    expect(first.count).toBe(2);
    const ids = first.messages.map((m) => m.id);
    expect(ids).toContain("wamid.pull.001");
    expect(ids).toContain("wamid.pull.002");

    // Buffer must NOT be drained — second pull returns the same messages.
    const second = service.pullWhatsAppRecent();
    expect(second.count).toBe(2);
  });

  it("pullWhatsAppRecent and syncWhatsAppInbound operate independently", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);

    const payload = makeWebhookPayload([
      { id: "wamid.indep.001", from: "+15551110001", body: "Hello" },
    ]);
    await service.ingestWhatsAppWebhook(payload);

    // Peek does not drain.
    const peek = service.pullWhatsAppRecent();
    expect(peek.count).toBe(1);

    // Drain via syncWhatsAppInbound.
    const sync = service.syncWhatsAppInbound();
    expect(sync.drained).toBe(1);

    // After drain, peek returns empty.
    const afterDrain = service.pullWhatsAppRecent();
    expect(afterDrain.count).toBe(0);
  });

  it("respects the limit parameter (newest messages)", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);

    const payload = makeWebhookPayload([
      { id: "wamid.limit.001", from: "+15551110001", body: "A" },
      { id: "wamid.limit.002", from: "+15551110002", body: "B" },
      { id: "wamid.limit.003", from: "+15551110003", body: "C" },
    ]);
    await service.ingestWhatsAppWebhook(payload);

    const result = service.pullWhatsAppRecent(2);
    expect(result.count).toBe(2);
    // Last two buffered messages are the most recent insertion order.
    const ids = result.messages.map((m) => m.id);
    expect(ids).toContain("wamid.limit.002");
    expect(ids).toContain("wamid.limit.003");
  });

  it("deduplicates when the same message arrives twice before pull", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);

    const payload = makeWebhookPayload([
      { id: "wamid.dedup.001", from: "+15551110001", body: "Original" },
    ]);
    // Simulate webhook retry.
    await service.ingestWhatsAppWebhook(payload);
    await service.ingestWhatsAppWebhook(payload);

    const result = service.pullWhatsAppRecent();
    // Despite two ingests, the buffer holds exactly one copy.
    expect(result.count).toBe(1);
    expect(result.messages[0].id).toBe("wamid.dedup.001");
  });

  it("returned messages mirror the WhatsAppMessage shape from the webhook parser", () => {
    // Test the shape independently of the service layer.
    const payload = makeWebhookPayload([
      { id: "wamid.shape.001", from: "+15551110001", body: "Shape test" },
    ]);
    parseAndBufferWhatsAppWebhookMessages(payload);

    const drained = drainWhatsAppInboundBuffer();
    expect(drained).toHaveLength(1);
    const msg = drained[0];
    expect(msg.id).toBe("wamid.shape.001");
    expect(msg.from).toBe("+15551110001");
    expect(msg.channelId).toBe("+15551110001");
    expect(msg.type).toBe("text");
    expect(msg.text).toBe("Shape test");
    expect(typeof msg.timestamp).toBe("string");
    expect(msg.metadata).toEqual({
      displayPhoneNumber: "+1 555 000 1111",
      phoneNumberId: "phone-pull",
      contactName: "WhatsApp +15551110001",
      waId: "+15551110001",
    });
  });
});
