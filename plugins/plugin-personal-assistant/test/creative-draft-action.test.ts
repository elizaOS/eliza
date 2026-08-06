/**
 * CREATIVE_DRAFT action tests cover the canonical attachment-transcript input,
 * owner-document style sourcing, and persisted compose-to-revise lifecycle with
 * deterministic runtime and document-service seams.
 */

import type {
  AddDocumentOptions,
  HandlerOptions,
  IAgentRuntime,
  Media,
  Memory,
  UUID,
} from "@elizaos/core";
import { ModelType } from "@elizaos/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const accessMocks = vi.hoisted(() => ({
  hasLifeOpsAccess: vi.fn(async () => true),
}));

vi.mock("../src/lifeops/access.js", () => ({
  hasLifeOpsAccess: accessMocks.hasLifeOpsAccess,
}));

import { creativeDraftAction } from "../src/actions/creative-draft.js";

const AGENT_ID = "00000000-0000-4000-8000-000000000001" as UUID;
const OWNER_ID = "00000000-0000-4000-8000-000000000002" as UUID;
const ROOM_ID = "00000000-0000-4000-8000-000000000003" as UUID;
const DRAFT_DOCUMENT_ID = "00000000-0000-4000-8000-000000000004" as UUID;
const OWNER_SOURCE_ID = "00000000-0000-4000-8000-000000000005" as UUID;

function voiceMessage(attachment: Media): Memory {
  return {
    id: "00000000-0000-4000-8000-000000000006" as UUID,
    agentId: AGENT_ID,
    entityId: OWNER_ID,
    roomId: ROOM_ID,
    content: {
      text: "Turn this voice memo into an essay in my voice.",
      attachments: [attachment],
    },
  };
}

function ownerSourceDocument(): Memory {
  return {
    id: OWNER_SOURCE_ID,
    agentId: AGENT_ID,
    entityId: OWNER_ID,
    roomId: ROOM_ID,
    content: {
      text: "Look, I think the point is simple. What matters is saying the hard thing plainly.",
    },
    metadata: {
      source: "sent_mail",
      filename: "owner-sent-mail.txt",
      addedBy: OWNER_ID,
    },
  };
}

function harness(options: { transcript?: string } = {}) {
  const stored = new Map<string, string>();
  const listDocuments = vi.fn(async () => [ownerSourceDocument()]);
  const addDocument = vi.fn(async (input: AddDocumentOptions) => {
    stored.set(DRAFT_DOCUMENT_ID, input.content);
    return {
      clientDocumentId: DRAFT_DOCUMENT_ID,
      storedDocumentMemoryId: DRAFT_DOCUMENT_ID,
      fragmentCount: 1,
    };
  });
  const getDocumentById = vi.fn(async (documentId: UUID) => {
    const content = stored.get(documentId);
    if (!content) return null;
    return {
      id: documentId,
      agentId: AGENT_ID,
      entityId: OWNER_ID,
      roomId: ROOM_ID,
      content: { text: content },
      metadata: {
        documentKind: "creative-owner-voice-draft",
        scope: "owner-private",
      },
    } satisfies Memory;
  });
  const updateDocument = vi.fn(
    async (input: { documentId: UUID; content: string }) => {
      stored.set(input.documentId, input.content);
      return { documentId: input.documentId, fragmentCount: 1 };
    },
  );
  const processAttachments = vi.fn(async (_runtime, attachments: Media[]) =>
    attachments.map((attachment) => ({
      ...attachment,
      ...(options.transcript === undefined
        ? {}
        : { text: options.transcript, description: options.transcript }),
    })),
  );
  const useModel = vi.fn(async (modelType: ModelType) => {
    if (modelType === ModelType.TEXT_LARGE) {
      return "Look, I think the point is simple: ship the honest version.";
    }
    throw new Error(`unexpected model ${modelType}`);
  });
  const documents = {
    listDocuments,
    addDocument,
    getDocumentById,
    updateDocument,
  };
  const runtime = {
    agentId: AGENT_ID,
    messageService: { processAttachments },
    getService: vi.fn((name: string) =>
      name === "documents" ? documents : null,
    ),
    useModel,
    reportError: vi.fn(),
  } as unknown as IAgentRuntime;
  return {
    runtime,
    stored,
    documents,
    processAttachments,
    useModel,
  };
}

async function runAction(
  runtime: IAgentRuntime,
  message: Memory,
  parameters: Record<string, unknown>,
) {
  return creativeDraftAction.handler(
    runtime,
    message,
    undefined,
    { parameters } as HandlerOptions,
    undefined,
  );
}

describe("CREATIVE_DRAFT persisted voice-memo workflow", () => {
  beforeEach(() => {
    accessMocks.hasLifeOpsAccess.mockReset().mockResolvedValue(true);
  });

  it("transcribes an incoming audio attachment, sources owner documents, and persists the draft", async () => {
    const test = harness({
      transcript: "They wasted six months. Keep that anger in the middle.",
    });
    const result = await runAction(
      test.runtime,
      voiceMessage({
        id: "voice-memo-1",
        url: "/api/media/voice-memo-1.m4a",
        contentType: "audio",
        mimeType: "audio/mp4",
        filename: "memo.m4a",
      }),
      {
        action: "compose",
        request: {
          title: "The Honest Version",
          targetForm: "essay",
          ownerAsk: "Turn this memo into an essay in my voice.",
        },
      },
    );

    expect(result.success).toBe(true);
    expect(test.processAttachments).toHaveBeenCalledOnce();
    expect(test.documents.listDocuments).toHaveBeenCalledWith(
      expect.objectContaining({ entityId: OWNER_ID }),
      expect.objectContaining({ addedBy: OWNER_ID }),
    );
    expect(test.documents.addDocument).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: "owner-private",
        scopedToEntityId: OWNER_ID,
        addedBy: OWNER_ID,
        addedByRole: "OWNER",
        addedFrom: "lifeops",
        metadata: expect.objectContaining({
          documentKind: "creative-owner-voice-draft",
        }),
      }),
    );
    expect(result.data).toMatchObject({
      draftDocumentId: DRAFT_DOCUMENT_ID,
      draft: {
        narrative:
          "Look, I think the point is simple: ship the honest version.",
        sourceMemoIds: ["voice-memo-1"],
        styleSourceIds: [OWNER_SOURCE_ID],
      },
    });
    const prompt = test.useModel.mock.calls[0]?.[1] as { prompt: string };
    expect(prompt.prompt).toContain("They wasted six months");
    expect(prompt.prompt).toContain('"the point is"');
  });

  it("reloads the persisted standing draft and updates it on a later revision turn", async () => {
    const test = harness({ transcript: "Start with the blunt version." });
    const initial = await runAction(
      test.runtime,
      voiceMessage({
        id: "voice-memo-2",
        url: "/api/media/voice-memo-2.wav",
        contentType: "audio",
        mimeType: "audio/wav",
      }),
      {
        action: "compose",
        request: {
          title: "Standing Memo",
          targetForm: "memo",
          ownerAsk: "Draft this memo.",
        },
      },
    );
    expect(initial.success).toBe(true);

    const revision = await runAction(
      test.runtime,
      {
        ...voiceMessage({
          id: "non-voice",
          url: "/api/media/reference.txt",
          contentType: "document",
        }),
        content: { text: "Keep that edit and sharpen the opening." },
      },
      {
        action: "revise",
        draftDocumentId: DRAFT_DOCUMENT_ID,
        revision: {
          instruction: "Keep the sharper opening.",
          acceptedEdit: "Sharper opening approved.",
          replacementText: "Look, start with the blunt truth.",
          revisedAt: "2026-08-06T12:00:00.000Z",
        },
      },
    );

    expect(revision.success).toBe(true);
    expect(test.documents.getDocumentById).toHaveBeenCalledWith(
      DRAFT_DOCUMENT_ID,
      expect.objectContaining({ entityId: OWNER_ID }),
    );
    expect(test.documents.updateDocument).toHaveBeenCalledOnce();
    expect(revision.data).toMatchObject({
      draftDocumentId: DRAFT_DOCUMENT_ID,
      draft: {
        acceptedEdits: ["Sharper opening approved."],
        sections: [{ text: "Look, start with the blunt truth." }],
      },
    });
    expect(
      JSON.parse(test.stored.get(DRAFT_DOCUMENT_ID) ?? "{}"),
    ).toMatchObject({
      kind: "creative-owner-voice-draft",
      draft: { acceptedEdits: ["Sharper opening approved."] },
    });
  });

  it("fails visibly instead of creating a draft when STT returns no transcript", async () => {
    const test = harness();
    const result = await runAction(
      test.runtime,
      voiceMessage({
        id: "silent-memo",
        url: "/api/media/silent.wav",
        contentType: "audio",
        mimeType: "audio/wav",
      }),
      {
        action: "compose",
        request: {
          title: "Silent Memo",
          targetForm: "memo",
          ownerAsk: "Draft this.",
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.data).toMatchObject({
      error: "CREATIVE_DRAFT_TRANSCRIPTION_EMPTY",
    });
    expect(test.documents.addDocument).not.toHaveBeenCalled();
  });
});
