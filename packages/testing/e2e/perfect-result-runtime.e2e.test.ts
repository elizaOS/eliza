/**
 * Runtime E2E: real assistant routing, authorization, action execution and durable
 * stores, with scenario-authored results replacing only external inference.
 * Audio assertions cover runtime model dispatch, not a production voice transport.
 */
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ChannelType,
  createMessageMemory,
  ModelType,
  type UUID,
} from "@elizaos/core";
import { createAssistantPlugin } from "../../../plugins/plugin-assistant/src/index.ts";
import notesPlugin from "../../../plugins/plugin-notes/src/index.ts";
import { strictActionRouteFixtures } from "../src/deterministic-action-fixtures.ts";
import { createTestRuntimeWithModelProvider } from "../src/model-provider-runtime.ts";

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  const finish = cleanup;
  cleanup = undefined;
  await finish?.();
});

// Valid PCM WAV fixture. Only external inference/audio generation is replaced;
// message processing, authorization, delivery and SQL persistence run normally.
function audioFixture(): ArrayBuffer {
  const wav = Buffer.alloc(44 + 320);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(320, 40);
  return wav.buffer.slice(wav.byteOffset, wav.byteOffset + wav.byteLength);
}

test.each([false, true])(
  "voice input reaches assistant, SQL history and voice delivery (streaming=%s)",
  async (streaming) => {
    const inputAudio = Buffer.from(audioFixture());
    const outputAudio = audioFixture();
    const input = "Say hello to Ada.";
    const reply = "Hello, Ada.";
    const harness = await createTestRuntimeWithModelProvider({
      plugins: [createAssistantPlugin()],
      ...(streaming ? { stream: { chunkSize: 7, intervalMs: 0 } } : {}),
      modelTypes: [ModelType.TRANSCRIPTION, ModelType.TEXT_EMBEDDING_BATCH],
      fixtures: [
        {
          name: "embedding-dimension-probe",
          match: (call) =>
            call.modelType === ModelType.TEXT_EMBEDDING && call.input === null,
          response: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
          times: 1,
        },
        {
          name: "conversation-embeddings",
          match: {
            modelType: ModelType.TEXT_EMBEDDING,
            input: (text) => text === input || text === reply,
          },
          response: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
          times: "any",
        },
        {
          name: "conversation-batch-embeddings",
          match: (call) =>
            call.modelType === ModelType.TEXT_EMBEDDING_BATCH &&
            typeof call.input === "object" &&
            call.input !== null &&
            "texts" in call.input &&
            Array.isArray(call.input.texts) &&
            call.input.texts.every((text) => text === input || text === reply),
          response: (call) =>
            (call.input as { texts: string[] }).texts.map(() =>
              Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
            ),
          times: "any",
        },
        {
          name: "transcribe-user-audio",
          match: (call) =>
            call.modelType === ModelType.TRANSCRIPTION &&
            Buffer.isBuffer(call.input) &&
            call.input.equals(inputAudio),
          response: input,
          times: 1,
        },
        {
          name: "reply-to-voice-message",
          match: {
            modelType: ModelType.RESPONSE_HANDLER,
            input: (text) => text.includes(input),
          },
          response: {
            contexts: ["simple"],
            intents: [],
            replyText: reply,
            candidateActionNames: [],
          },
          times: 1,
        },
        {
          name: "speak-delivered-reply",
          match: { modelType: ModelType.TEXT_TO_SPEECH, input: reply },
          response: outputAudio,
          times: 1,
        },
      ],
    });
    cleanup = harness.cleanup;
    const { runtime } = harness;
    await Promise.all(
      runtime
        .getRegisteredServiceTypes()
        .map((type) => runtime.getServiceLoadPromise(type)),
    );
    const roomId = randomUUID() as UUID;
    const userId = randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId: randomUUID() as UUID,
      userName: "Ada",
      source: "voice",
      channelId: roomId,
      type: ChannelType.DM,
    });
    const transcription = await runtime.useModel(
      ModelType.TRANSCRIPTION,
      inputAudio,
    );
    const inbound = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: transcription,
        source: "voice",
        channelType: ChannelType.DM,
      },
    });
    const delivered: ArrayBuffer[] = [];
    const chunks: string[] = [];
    if (!runtime.messageService)
      throw new Error("Assistant message service did not start");
    const result = await runtime.messageService.handleMessage(
      runtime,
      inbound,
      async (content) => {
        if (content.text) {
          const audio = await runtime.useModel(ModelType.TEXT_TO_SPEECH, {
            text: content.text,
          });
          expect(audio).toBeInstanceOf(ArrayBuffer);
          delivered.push(audio as ArrayBuffer);
        }
        return [];
      },
      streaming
        ? {
            onStreamChunk: async (chunk: string) => {
              chunks.push(chunk);
            },
          }
        : {},
    );
    expect(result.responseContent?.text).toBe(reply);
    expect(delivered).toHaveLength(1);
    // Stage-1 structure must stay private; the validated reply is delivered above.
    if (streaming)
      expect(chunks.join("")).not.toContain("candidateActionNames");
    expect(Buffer.from(delivered[0])).toEqual(Buffer.from(outputAudio));
    const history = await runtime.getMemories({
      roomId,
      tableName: "messages",
      count: 20,
    });
    expect(
      history.some(
        (memory) => memory.entityId === userId && memory.content.text === input,
      ),
    ).toBe(true);
    expect(
      history.some(
        (memory) =>
          memory.entityId === runtime.agentId && memory.content.text === reply,
      ),
    ).toBe(true);
    harness.assertFixturesConsumed();
  },
  120_000,
);

test.each([false, true])(
  "native tool response creates a durable note through the assistant (clientStreaming=%s)",
  async (streaming) => {
    const stateDir = await mkdtemp(join(tmpdir(), "perfect-result-notes-"));
    const previousStateDir = process.env.ELIZA_STATE_DIR;
    process.env.ELIZA_STATE_DIR = stateDir;
    let stop: (() => Promise<void>) | undefined;
    cleanup = async () => {
      try {
        await stop?.();
      } finally {
        if (previousStateDir === undefined) delete process.env.ELIZA_STATE_DIR;
        else process.env.ELIZA_STATE_DIR = previousStateDir;
        await rm(stateDir, { recursive: true, force: true });
      }
    };
    const userId = randomUUID() as UUID;
    const input =
      'Save a note with the exact content "Ada\nBring the notebook."';
    const content = "Ada\nBring the notebook.";
    const harness = await createTestRuntimeWithModelProvider({
      characterName: `Notes-${randomUUID()}`,
      plugins: [createAssistantPlugin(), notesPlugin],
      settings: { ELIZA_ADMIN_ENTITY_ID: userId },
      ...(streaming ? { stream: { chunkSize: 7, intervalMs: 0 } } : {}),
      fixtures: [
        {
          name: "note-embeddings",
          match: {
            modelType: ModelType.TEXT_EMBEDDING,
            input: (text) =>
              text === "" ||
              text.includes("Ada") ||
              text.includes("notebook") ||
              text.includes("Saved"),
          },
          response: Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0)),
          times: { min: 1, max: 12 },
        },
        ...strictActionRouteFixtures({
          actionName: "NOTES_CREATE",
          args: { content },
          input,
          contextIds: ["notes"],
          messageToUser: "Saved your note.",
        }),
      ],
    });
    stop = harness.cleanup;
    const { runtime } = harness;
    await Promise.all(
      runtime
        .getRegisteredServiceTypes()
        .map((type) => runtime.getServiceLoadPromise(type)),
    );
    const roomId = randomUUID() as UUID;
    await runtime.ensureConnection({
      entityId: userId,
      roomId,
      worldId: randomUUID() as UUID,
      userName: "Ada",
      source: "client_chat",
      channelId: roomId,
      type: ChannelType.DM,
    });
    const inbound = createMessageMemory({
      id: randomUUID() as UUID,
      entityId: userId,
      roomId,
      content: {
        text: input,
        source: "client_chat",
        channelType: ChannelType.DM,
      },
    });
    const replies: string[] = [];
    if (!runtime.messageService)
      throw new Error("Assistant message service did not start");
    await runtime.messageService.handleMessage(
      runtime,
      inbound,
      async (message) => {
        if (message.text) replies.push(message.text);
        return [];
      },
      streaming ? { onStreamChunk: async () => {} } : {},
    );
    const stored = JSON.parse(
      await readFile(
        join(stateDir, "notes", "agents", runtime.agentId, "state.json"),
        "utf8",
      ),
    );
    expect(stored.notes).toHaveLength(1);
    expect(stored.notes[0].title).toBe("Ada");
    expect(stored.notes[0].body).toBe("Bring the notebook.");
    expect(replies.join("\n")).toContain("Saved");
    const history = await runtime.getMemories({
      roomId,
      tableName: "messages",
      count: 20,
    });
    expect(
      history.some(
        (memory) =>
          memory.entityId === runtime.agentId &&
          memory.content.text?.includes("Saved"),
      ),
    ).toBe(true);
    const plannerCall = harness
      .getFixtureDiagnostics()
      .calls.find((call) => call.modelType === ModelType.ACTION_PLANNER);
    // The planner installs its own stream collector even without a client callback.
    expect(plannerCall?.streaming).toBe(true);
    harness.assertFixturesConsumed();
  },
  120_000,
);
