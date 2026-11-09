/** Owner-voice drafts revise through the real documents service on PGlite, including drafts stored as source segments. */
import { randomUUID } from "node:crypto";
import {
  ChannelType,
  DOCUMENT_PARENT_INLINE_MAX_BYTES,
  type Memory,
  resolveOwnerEntityIdOrDefault,
  type UUID,
} from "@elizaos/core";
import { createDocumentsPlugin } from "@elizaos/plugin-assistant";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createLifeOpsTestRuntime,
  type RealTestRuntimeResult,
} from "../../test/helpers/runtime.js";
import type { CreativeDraftArtifact } from "../lifeops/creative-draft/index.js";
import { creativeDraftAction } from "./creative-draft.js";

let host: RealTestRuntimeResult;

beforeAll(async () => {
  host = await createLifeOpsTestRuntime({
    plugins: [createDocumentsPlugin({ enableActions: false })],
  });
}, 240_000);

afterAll(async () => {
  await host?.cleanup();
});

interface OwnerRoom {
  owner: UUID;
  roomId: UUID;
  worldId: UUID;
}

async function createOwnerRoom(): Promise<OwnerRoom> {
  const runtime = host.runtime;
  const owner = resolveOwnerEntityIdOrDefault(runtime);
  const worldId = randomUUID() as UUID;
  const roomId = randomUUID() as UUID;
  await runtime.ensureWorldExists({
    id: worldId,
    name: "Owner world",
    agentId: runtime.agentId,
    messageServerId: randomUUID() as UUID,
    metadata: { ownership: { ownerId: owner } },
  });
  await runtime.ensureRoomExists({
    id: roomId,
    name: "Owner DM",
    source: "dashboard",
    type: ChannelType.DM,
    worldId,
    agentId: runtime.agentId,
  });
  await runtime.ensureConnection({
    entityId: owner,
    roomId,
    worldId,
    source: "dashboard",
    type: ChannelType.DM,
    name: "Owner",
    userName: "owner",
  });
  return { owner, roomId, worldId };
}

function ownerTurn(room: OwnerRoom, text: string): Memory {
  return {
    id: randomUUID() as UUID,
    agentId: host.runtime.agentId,
    entityId: room.owner,
    roomId: room.roomId,
    worldId: room.worldId,
    createdAt: Date.now(),
    content: { text, source: "dashboard" },
  };
}

const memoSentence =
  "I keep coming back to the launch because we shipped the version nobody asked for and called it strategy. ";

async function composeDraft(room: OwnerRoom, memoSentences: number) {
  const result = await creativeDraftAction.handler(
    host.runtime,
    ownerTurn(room, "Turn these voice memos into an essay in my voice."),
    undefined,
    {
      parameters: {
        action: "compose",
        request: {
          title: "The Honest Version",
          targetForm: "essay",
          ownerAsk: "Turn these memos into an essay in my voice.",
        },
        memos: ["memo-anger", "memo-hope", "memo-plan"].map((id) => ({
          id,
          transcript: `${id}: ${memoSentence.repeat(memoSentences)}`,
        })),
      },
    },
    undefined,
  );
  expect(result?.success, String(result?.text)).toBe(true);
  const draftDocumentId = result?.data?.draftDocumentId;
  expect(typeof draftDocumentId).toBe("string");
  return draftDocumentId as string;
}

async function reviseStandingDraft(room: OwnerRoom, acceptedEdit: string) {
  const instruction = "Keep the anger in the second section.";
  return creativeDraftAction.handler(
    host.runtime,
    ownerTurn(room, instruction),
    undefined,
    {
      parameters: {
        action: "revise",
        revision: {
          instruction,
          acceptedEdit,
          revisedAt: new Date().toISOString(),
        },
      },
    },
    undefined,
  );
}

it("revises a standing draft stored inline", async () => {
  const room = await createOwnerRoom();
  const draftDocumentId = await composeDraft(room, 20);
  const stored = await host.runtime.getMemoryById(draftDocumentId as UUID);
  expect(stored?.content.documentSource).toBeUndefined();

  const revised = await reviseStandingDraft(room, "Sharper second section.");

  expect(revised?.success, String(revised?.text)).toBe(true);
  expect(revised?.data?.draftDocumentId).toBe(draftDocumentId);
}, 120_000);

it("revises a standing draft whose stored JSON exceeds the inline parent limit", async () => {
  const room = await createOwnerRoom();
  // Three dictated memos of about 4,000 words each.
  const draftDocumentId = await composeDraft(room, 220);
  const stored = await host.runtime.getMemoryById(draftDocumentId as UUID);
  const source = stored?.content.documentSource as
    | { kind: string; storage: string; byteLength: number }
    | undefined;
  expect(stored?.content.text).toBeUndefined();
  expect(source).toMatchObject({
    kind: "document-source",
    storage: "segments",
  });
  expect(source?.byteLength).toBeGreaterThan(DOCUMENT_PARENT_INLINE_MAX_BYTES);

  const first = await reviseStandingDraft(room, "Sharper second section.");
  expect(first?.success, String(first?.text)).toBe(true);
  expect(first?.data?.draftDocumentId).toBe(draftDocumentId);

  // The revision was written back, so the next turn reads it again.
  const second = await reviseStandingDraft(room, "Keep the closing line.");
  expect(second?.success, String(second?.text)).toBe(true);
  const draft = second?.data?.draft as CreativeDraftArtifact | undefined;
  expect(draft?.acceptedEdits).toEqual([
    "Sharper second section.",
    "Keep the closing line.",
  ]);
}, 120_000);
