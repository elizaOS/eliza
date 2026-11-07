/** A transient Bot API file lookup failure must not erase the durable file-id capability. */
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { IAgentRuntime } from "@elizaos/core";
import { Telegraf } from "telegraf";
import { expect, it } from "vitest";
import { MessageManager } from "./messageManager";

const BOT_TOKEN = "999999999:AA_test_dummy_telegram_bot_token";

it("keeps a document file reference when the real Telegraf lookup fails", async () => {
  let getFileCalls = 0;
  const server = createServer((req, res) => {
    if (req.url?.endsWith("/getFile")) getFileCalls += 1;
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        ok: false,
        error_code: 502,
        description: "Bad Gateway",
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  try {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Telegram test server did not bind to a TCP address");
    }
    const { port } = address satisfies AddressInfo;
    const bot = new Telegraf(BOT_TOKEN, {
      telegram: { apiRoot: `http://127.0.0.1:${port}` },
    });
    const runtime = {
      agentId: "00000000-0000-0000-0000-000000000001",
      getService: () => null,
    } as unknown as IAgentRuntime;
    const manager = new MessageManager(bot, runtime);

    const result = await manager.processMessage({
      message_id: 1,
      date: 1,
      chat: { id: 1, type: "private" },
      document: {
        file_id: "document-retry-id",
        file_unique_id: "document-unique-id",
        file_name: "report.bin",
        mime_type: "application/octet-stream",
        file_size: 42,
      },
    });

    expect(getFileCalls).toBe(1);
    expect(result.attachments).toEqual([
      expect.objectContaining({
        id: "document-retry-id",
        url: "telegram-file:document-retry-id",
        contentType: "document",
      }),
    ]);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
