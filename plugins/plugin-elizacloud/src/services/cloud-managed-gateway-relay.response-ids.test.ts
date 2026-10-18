/**
 * A Cloud gateway message relayed to a local runtime can get several reply
 * callbacks in one turn, for example a text reply and then an attachment-only
 * reply (ATTACH_TO_CHAT). Each must be stored as its own response memory.
 * Real AgentRuntime with the SQLite adapter and the real relay handler; only
 * the message service's turn is scripted.
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  AgentRuntime,
  type Content,
  createUniqueUuid,
  type HandlerCallback,
  type UUID,
} from "@elizaos/core";
import { SQLiteDatabaseAdapter } from "@elizaos/testing/runtime";
import { expect, it } from "vitest";
import { CloudManagedGatewayRelayService } from "./cloud-managed-gateway-relay";

it("stores a text reply and a following attachment-only reply as two memories", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "gateway-relay-ids-"));
  const agentId = randomUUID() as UUID;
  const runtime = new AgentRuntime({
    agentId,
    character: { name: "Relay", bio: [], settings: {} },
    logLevel: "fatal",
  });
  runtime.registerDatabaseAdapter(
    SQLiteDatabaseAdapter.create(path.join(directory, "state.sqlite"), agentId)
  );
  try {
    await runtime.init();
    (runtime as unknown as { messageService: unknown }).messageService = {
      handleMessage: async (_rt: unknown, _message: unknown, callback: HandlerCallback) => {
        await callback({ text: "Here it is" } as Content);
        await callback({
          text: "",
          attachments: [{ id: "doc-1", url: "https://example.com/onboarding.pdf" }],
        } as Content);
        return { didRespond: true };
      },
    };
    const service = new CloudManagedGatewayRelayService();
    (service as unknown as { runtime: unknown }).runtime = runtime;

    const response = await (
      service as unknown as {
        handleMessageSend: (rpc: unknown) => Promise<{ result?: { text?: string } }>;
      }
    ).handleMessageSend({
      jsonrpc: "2.0",
      id: randomUUID(),
      method: "message.send",
      params: {
        source: "telegram",
        text: "attach the onboarding doc",
        sender: { id: "user-1", username: "ana" },
        roomId: "telegram:chat-1",
      },
    });
    expect(response.result?.text).toBe("Here it is");

    // The relay's room for a non-UUID room key.
    const roomId = createUniqueUuid(runtime, "telegram:chat-1");
    const replies = (await runtime.getMemories({ tableName: "messages", roomId, count: 50 }))
      .filter((memory) => memory.entityId === agentId);
    expect(replies).toHaveLength(2);
    expect(replies.some((memory) => (memory.content.attachments?.length ?? 0) === 1)).toBe(true);
  } finally {
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 60_000);
