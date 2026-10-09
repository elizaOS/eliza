/** Exercises real service chunking and Blooio parsing with a deterministic HTTP boundary; no native messages are sent. */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IAgentRuntime } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { IMessageService } from "./service.js";
import type { IMessageSettings } from "./types.js";

function fixture(transport: "blooio" | "native" = "blooio") {
  const runtime = {
    agentId: "00000000-0000-0000-0000-000000000001",
    emitEvent: vi.fn(),
  } as unknown as IAgentRuntime;
  const service = new IMessageService(runtime);
  const internal = service as unknown as {
    settings: IMessageSettings;
    runAppleScript: (script: string) => Promise<string>;
  };
  internal.settings = {
    transport,
    pollIntervalMs: 0,
    heartbeatIntervalMs: 60000,
    dmPolicy: "open",
    groupPolicy: "allowlist",
    allowFrom: [],
    enabled: true,
    blooioApiKey: "synthetic-api-key",
    blooioWebhookSecret: "synthetic-secret",
    blooioFromNumber: "+15551234567",
    blooioChannelId: "ch_synthetic",
  };
  internal.runAppleScript = vi.fn(async () => "");
  return { service, internal };
}
afterEach(() => vi.unstubAllGlobals());

it("retains the provider receipt instead of replacing it with a timestamp", async () => {
  const send = vi.fn(
    async () => new Response(JSON.stringify({ id: "provider-message-1" }), { status: 200 })
  );
  vi.stubGlobal("fetch", send);
  const { service } = fixture();
  expect(await service.sendMessage("+15557654321", "Synthetic review")).toMatchObject({
    success: true,
    messageId: "provider-message-1",
    messageIds: ["provider-message-1"],
  });
  expect(send).toHaveBeenCalledTimes(1);
});

it("retains every accepted chunk receipt in send order", async () => {
  let sequence = 0;
  const send = vi.fn(
    async () => new Response(JSON.stringify({ id: `provider-part-${++sequence}` }), { status: 200 })
  );
  vi.stubGlobal("fetch", send);
  const { service } = fixture();
  expect(await service.sendMessage("+15557654321", "x".repeat(4001))).toMatchObject({
    success: true,
    messageId: "provider-part-2",
    messageIds: ["provider-part-1", "provider-part-2"],
  });
  expect(send).toHaveBeenCalledTimes(2);
});

it("preserves accepted chunk evidence when a later chunk fails", async () => {
  const send = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ id: "accepted-part" }), { status: 200 }))
    .mockResolvedValueOnce(new Response("unavailable", { status: 503 }));
  vi.stubGlobal("fetch", send);
  const { service } = fixture();
  expect(await service.sendMessage("+15557654321", "x".repeat(4001))).toMatchObject({
    success: false,
    messageIds: ["accepted-part"],
  });
  expect(send).toHaveBeenCalledTimes(2);
});

it("does not invent a provider receipt for native automation acceptance", async () => {
  const { service, internal } = fixture("native");
  const result = await service.sendMessage("+15557654321", "Synthetic review");
  expect(result.success).toBe(true);
  expect(result.messageId).toBeUndefined();
  expect(internal.runAppleScript).toHaveBeenCalledTimes(1);
});

it("stages every attachment before sending and preserves partial native completion evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "imessage-attachments-"));
  const first = join(directory, "one.txt"),
    second = join(directory, "two.txt");
  await writeFile(first, "one");
  await writeFile(second, "two");
  try {
    const { service, internal } = fixture("native");
    const result = await service.sendMessage("+15557654321", "caption", {
      mediaUrls: [first, second],
    });
    expect(result.success).toBe(true);
    expect(result.localEffectIds).toHaveLength(3);
    expect(new Set(result.localEffectIds).size).toBe(3);
    expect(result.messageIds).toEqual([]);
    expect(internal.runAppleScript).toHaveBeenCalledTimes(3);

    const failed = fixture("native");
    vi.mocked(failed.internal.runAppleScript)
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("")
      .mockRejectedValueOnce(new Error("native boundary failed"));
    const partial = await failed.service.sendMessage("+15557654321", "caption", {
      mediaUrls: [first, second],
    });
    expect(partial.success).toBe(false);
    expect(partial.localEffectIds).toHaveLength(2);
    expect(partial.messageIds).toEqual([]);

    const invalid = fixture("native");
    expect(
      (
        await invalid.service.sendMessage("+15557654321", "caption", {
          mediaUrls: [first, join(directory, "missing")],
        })
      ).success
    ).toBe(false);
    expect(invalid.internal.runAppleScript).not.toHaveBeenCalled();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
