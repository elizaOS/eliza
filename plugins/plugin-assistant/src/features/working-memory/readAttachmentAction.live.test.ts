/**
 * Exercises assistant attachment reading through a real AgentRuntime and live
 * provider. Explicit opt-in and credentials are required; skipped discovery is
 * not evidence that the model path passed.
 */
import { randomUUID as uuidv4 } from "node:crypto";
import type { HandlerCallback, Media, Memory, UUID } from "@elizaos/core";
import { ChannelType, ContentType, EventType, ModelType } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { describeLive } from "../../../../../packages/app/test/helpers/live-agent-test.ts";
import { readAttachmentAction } from "./readAttachmentAction.ts";

if (process.env.ELIZA_LIVE_TEST !== "1") {
  process.env.SKIP_REASON ||=
    "set ELIZA_LIVE_TEST=1 to run the attachment live-provider contract";
  describe("ATTACHMENT read live", () => {
    it.skip("requires ELIZA_LIVE_TEST=1", () => {});
  });
} else {
  await describeLive(
    "ATTACHMENT read live (Cerebras)",
    {
      requiredEnv: [
        process.env.OPENAI_API_KEY?.trim()
          ? "OPENAI_API_KEY"
          : "CEREBRAS_API_KEY",
      ],
    },
    ({ harness }) => {
      it("reads a text attachment and returns a real LLM answer containing the secret token", async () => {
        const { runtime, agentId } = harness();

        const modelTypes: string[] = [];
        runtime.registerEvent(EventType.MODEL_USED, async (payload) => {
          modelTypes.push(payload.type);
        });

        const secret = "saffron-anchor-7421";
        const attachment: Media = {
          id: "attachment-1",
          url: "https://example.test/attachment-1.txt",
          title: "secret.txt",
          source: "Plaintext",
          contentType: ContentType.DOCUMENT,
          text: `Secret phrase: ${secret}\nReturn only the secret phrase, nothing else.`,
        };

        const message: Memory = {
          id: uuidv4() as UUID,
          agentId,
          entityId: uuidv4() as UUID,
          roomId: uuidv4() as UUID,
          createdAt: Date.now(),
          content: {
            text: "read this attachment and reply with only the secret phrase",
            source: "live-test",
            attachments: [attachment],
          },
        };

        const worldId = uuidv4() as UUID;
        await runtime.createWorld({
          id: worldId,
          name: "attachment-live-world",
          agentId,
        });
        await runtime.createEntity({
          id: message.entityId,
          names: ["AttachmentLiveUser"],
          agentId,
        });
        await runtime.ensureRoomExists({
          id: message.roomId,
          name: "attachment-live-room",
          worldId,
          source: "live-test",
          type: ChannelType.DM,
        });
        await runtime.ensureParticipantInRoom(message.entityId, message.roomId);
        await runtime.createMemory(message, "messages");

        let callbackText = "";
        const callback: HandlerCallback = async (content) => {
          if (typeof content?.text === "string") callbackText = content.text;
          return [];
        };

        const result = await readAttachmentAction.handler?.(
          runtime,
          message,
          undefined,
          { parameters: { action: "read" } },
          callback,
        );

        expect(result?.success).toBe(true);
        expect(typeof result?.text).toBe("string");
        expect(callbackText.length).toBeGreaterThan(0);
        expect(callbackText.trim()).toBe(secret);
        expect(modelTypes).toContain(ModelType.TEXT_SMALL);
        expect(String(result?.text).toLowerCase()).toContain(
          secret.toLowerCase(),
        );
      }, 120_000);
    },
  );
}
