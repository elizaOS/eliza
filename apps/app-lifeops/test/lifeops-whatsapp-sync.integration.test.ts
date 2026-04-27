/**
 * Integration test: WhatsApp periodic sync via `syncWhatsAppInbound()`.
 *
 * No live WhatsApp credentials are required. The test exercises the in-process
 * buffer that `ingestWhatsAppWebhook()` populates, and verifies that
 * `syncWhatsAppInbound()` drains it with correct deduplication.
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
                phone_number_id: "phone-sync",
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

describe("Integration: WhatsApp inbound sync", () => {
  let oauthDir: string;
  let prevOAuthDir: string | undefined;
  let prevStateDir: string | undefined;
  let prevDisableProactive: string | undefined;
  let runtime: Awaited<ReturnType<typeof createLifeOpsTestRuntime>> | undefined;

  beforeEach(async () => {
    // Drain any leftovers from a previous test.
    drainWhatsAppInboundBuffer();

    oauthDir = await mkdtemp(path.join(os.tmpdir(), "lifeops-whatsapp-sync-"));
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

  it("connector status always reports inbound: true", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);
    const status = await service.getWhatsAppConnectorStatus();
    expect(status.inbound).toBe(true);
  });

  it("syncWhatsAppInbound returns empty when no messages have been ingested", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);
    const result = service.syncWhatsAppInbound();
    expect(result.drained).toBe(0);
    expect(result.messages).toEqual([]);
  });

  it("ingestWhatsAppWebhook buffers messages that syncWhatsAppInbound drains", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);

    const payload = makeWebhookPayload([
      { id: "wamid.001", from: "+15551110001", body: "Hello from WhatsApp" },
      { id: "wamid.002", from: "+15551110002", body: "Another message" },
    ]);

    const ingest = await service.ingestWhatsAppWebhook(payload);
    expect(ingest.ingested).toBe(2);

    const sync = service.syncWhatsAppInbound();
    expect(sync.drained).toBe(2);
    const ids = sync.messages.map((m) => m.id);
    expect(ids).toContain("wamid.001");
    expect(ids).toContain("wamid.002");
    expect(sync.messages[0]).toMatchObject({
      channelId: "+15551110001",
      metadata: {
        displayPhoneNumber: "+1 555 000 1111",
        phoneNumberId: "phone-sync",
        contactName: "WhatsApp +15551110001",
        waId: "+15551110001",
      },
    });
  });

  it("deduplicates messages with the same id across multiple ingests", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);

    const payload = makeWebhookPayload([
      { id: "wamid.dup", from: "+15551110001", body: "First delivery" },
    ]);

    await service.ingestWhatsAppWebhook(payload);
    // Deliver the same message again (simulates webhook retry).
    await service.ingestWhatsAppWebhook(payload);

    const sync = service.syncWhatsAppInbound();
    // Despite two ingests, the buffer holds exactly one copy.
    expect(sync.drained).toBe(1);
    expect(sync.messages[0].id).toBe("wamid.dup");
  });

  it("drain empties the buffer; second drain returns empty", async () => {
    runtime = await createLifeOpsTestRuntime();
    const service = new LifeOpsService(runtime.runtime);

    const payload = makeWebhookPayload([
      { id: "wamid.once", from: "+15551110001", body: "Hello" },
    ]);
    await service.ingestWhatsAppWebhook(payload);

    const first = service.syncWhatsAppInbound();
    expect(first.drained).toBe(1);

    const second = service.syncWhatsAppInbound();
    expect(second.drained).toBe(0);
  });

  it("parseAndBufferWhatsAppWebhookMessages populates the buffer directly", () => {
    const payload = makeWebhookPayload([
      { id: "wamid.direct", from: "+15551110003", body: "Direct buffer" },
    ]);
    const messages = parseAndBufferWhatsAppWebhookMessages(payload);
    expect(messages).toHaveLength(1);

    const drained = drainWhatsAppInboundBuffer();
    expect(drained).toHaveLength(1);
    expect(drained[0].id).toBe("wamid.direct");
  });
});
