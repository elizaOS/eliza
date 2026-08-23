/**
 * Proves inbound Baileys metadata and per-message media failures reach runtime
 * diagnostics while the connector event loop remains available for later work.
 */

import { EventEmitter } from "node:events";
import { ElizaError, type IAgentRuntime, type UUID } from "@elizaos/core";
import { describe, expect, it, vi } from "vitest";
import { BaileysClient } from "../src/clients/baileys-client";
import { WhatsAppConnectorService } from "../src/runtime-service";
import type { NormalizedMessage } from "../src/types";

function diagnosticRuntime() {
  return {
    agentId: "agent-diagnostics" as UUID,
    getSetting: vi.fn(() => undefined),
    reportError: vi.fn(),
    logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
  } as never as IAgentRuntime;
}

function bindFakeBaileysClient(service: WhatsAppConnectorService): EventEmitter {
  const emitter = new EventEmitter();
  const client = Object.assign(Object.create(BaileysClient.prototype), {
    on: emitter.on.bind(emitter),
  }) as BaileysClient;
  const bindClientEvents = Reflect.get(service, "bindClientEvents") as (
    client: BaileysClient,
    accountId: string
  ) => void;
  bindClientEvents.call(service, client, "named-account");
  return emitter;
}

describe("WhatsApp runtime diagnostics", () => {
  it("reports Baileys metadata failures with account and stage context", () => {
    const runtime = diagnosticRuntime();
    const service = new WhatsAppConnectorService(runtime);
    const emitter = bindFakeBaileysClient(service);
    const error = new ElizaError("provider filename is unsafe", {
      code: "WHATSAPP_PERSONAL_MEDIA_FILENAME_INVALID",
      severity: "ephemeral",
    });

    emitter.emit("error", error);

    expect(runtime.reportError).toHaveBeenCalledWith("plugin:whatsapp:client", error, {
      accountId: "named-account",
      stage: "baileys-metadata-or-socket",
    });
  });

  it("reports a media fetch/store/decrypt failure and continues handling later messages", async () => {
    const runtime = diagnosticRuntime();
    const service = new WhatsAppConnectorService(runtime);
    const failure = new ElizaError("guarded fetch denied", {
      code: "WHATSAPP_PERSONAL_MEDIA_LOCATION_DENIED",
      severity: "ephemeral",
    });
    const handleNormalizedMessage = vi
      .fn<(message: NormalizedMessage, accountId: string) => Promise<void>>()
      .mockRejectedValueOnce(failure)
      .mockResolvedValueOnce(undefined);
    Reflect.set(service, "handleNormalizedMessage", handleNormalizedMessage);
    const emitter = bindFakeBaileysClient(service);
    const message = {
      id: "provider-media-1",
      from: "group@g.us",
      chatId: "group@g.us",
      senderId: "user@s.whatsapp.net",
      timestamp: 1,
      type: "image",
      content: "caption",
      personalMedia: {
        kind: "image",
        mediaKey: new Uint8Array(32),
        fileSha256: new Uint8Array(32),
        fileEncSha256: new Uint8Array(32),
        fileLength: 1,
        mimeType: "image/png",
        url: "https://media.whatsapp.net/media.enc",
      },
    } satisfies NormalizedMessage;

    emitter.emit("message", message);
    await vi.waitFor(() =>
      expect(runtime.reportError).toHaveBeenCalledWith(
        "plugin:whatsapp:inbound-message",
        failure,
        {
          accountId: "named-account",
          chatId: "group@g.us",
          externalMessageId: "provider-media-1",
          stage: "media-fetch-store-decrypt",
        }
      )
    );

    emitter.emit("message", { ...message, id: "provider-media-2" });
    await vi.waitFor(() => expect(handleNormalizedMessage).toHaveBeenCalledTimes(2));
  });
});
