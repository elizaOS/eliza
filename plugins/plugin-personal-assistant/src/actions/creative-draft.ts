/**
 * `CREATIVE_DRAFT` action — owner-voice drafting from transcribed memos and
 * owner-authored exemplars. It consumes voice transcripts produced by the
 * canonical attachment pipeline, sources owner-authored documents, builds an
 * owner-voice style card, and persists the standing draft in the shared
 * owner-private document store. One live model pass uses the sanctioned
 * `creative_draft` OptimizedPromptService task and scores owner-voice fidelity.
 *
 * Subactions:
 *   - `compose` — build a style card from exemplars + memos and draft in the
 *     owner's voice, returning a `CreativeDraftArtifact` and a fidelity score.
 *   - `revise`  — reload a persisted draft, apply a `CreativeDraftRevision`
 *     (targeting the section named by `sectionId`/`sectionIndex`), then
 *     re-compose and persist the narrative.
 *
 * Owner-only via `hasLifeOpsAccess`.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  DocumentService,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Media,
  Memory,
  UUID,
} from "@elizaos/core";
import {
  ElizaError,
  logger,
  ModelType,
  runWithTrajectoryPurpose,
  toWellFormedUnicode,
  truncateWellFormed,
} from "@elizaos/core";
import { hasLifeOpsAccess } from "../lifeops/access.js";
import {
  applyCreativeDraftRevision,
  buildCreativeDraftPrompt,
  buildOwnerVoiceStyleCard,
  CREATIVE_DRAFT_OPTIMIZATION_TASK,
  type CreativeDraftArtifact,
  type CreativeDraftRequest,
  type CreativeDraftRevision,
  type CreativeMemoTranscript,
  createCreativeDraftArtifact,
  creativeDraftNarrativeViolations,
  type OwnerVoiceSource,
  scoreOwnerVoiceFidelity,
} from "../lifeops/creative-draft/index.js";

const ACTION_NAME = "CREATIVE_DRAFT";

const SUBACTIONS = ["compose", "revise"] as const;
type Subaction = (typeof SUBACTIONS)[number];

const SIMILE_NAMES: readonly string[] = [
  "CREATIVE_DRAFT",
  "DRAFT_IN_MY_VOICE",
  "OWNER_VOICE_DRAFT",
  "WRITE_IN_MY_VOICE",
  "GHOSTWRITE",
];

interface CreativeDraftActionParameters {
  action?: Subaction | string;
  subaction?: Subaction | string;
  op?: Subaction | string;
  request?: CreativeDraftRequest;
  memos?: readonly CreativeMemoTranscript[];
  ownerSources?: readonly OwnerVoiceSource[];
  draftDocumentId?: string;
  currentDraft?: CreativeDraftArtifact;
  revision?: CreativeDraftRevision;
}

interface StoredCreativeDraftEnvelope {
  readonly schemaVersion: 1;
  readonly kind: "creative-owner-voice-draft";
  readonly draft: CreativeDraftArtifact;
}

type CreativeDraftDocumentService = Pick<
  DocumentService,
  "addDocument" | "getDocumentById" | "listDocuments" | "updateDocument"
>;

const CREATIVE_DRAFT_DOCUMENT_KIND = "creative-owner-voice-draft";
const MAX_OWNER_VOICE_SOURCES = 12;
const MAX_OWNER_SOURCE_CHARS = 6_000;

function getParams(
  options: HandlerOptions | undefined,
): CreativeDraftActionParameters {
  const raw = (options as HandlerOptions | undefined)?.parameters;
  if (raw && typeof raw === "object") {
    return raw as CreativeDraftActionParameters;
  }
  return {};
}

function resolveSubaction(
  params: CreativeDraftActionParameters,
): Subaction | null {
  for (const candidate of [params.action, params.subaction, params.op]) {
    if (typeof candidate !== "string") continue;
    const lower = candidate.trim().toLowerCase();
    if ((SUBACTIONS as readonly string[]).includes(lower)) {
      return lower as Subaction;
    }
  }
  return null;
}

/**
 * Run the sanctioned drafting prompt through a live model pass. A failed
 * compose degrades to the structured artifact without narrative text —
 * symmetric with the other LifeOps LLM consumers (brief, scheduling) — so a
 * transient model failure never loses the composed sections.
 */
async function composeDraftNarrative(args: {
  runtime: IAgentRuntime;
  request: CreativeDraftRequest;
  memos: readonly CreativeMemoTranscript[];
  styleCard: ReturnType<typeof buildOwnerVoiceStyleCard>;
  currentDraft: CreativeDraftArtifact;
}): Promise<string | undefined> {
  if (typeof args.runtime.useModel !== "function") return undefined;
  const prompt = buildCreativeDraftPrompt({
    request: args.request,
    memos: args.memos,
    styleCard: args.styleCard,
    currentDraft: args.currentDraft,
    runtime: args.runtime,
  });
  let raw: unknown;
  try {
    raw = await runWithTrajectoryPurpose(CREATIVE_DRAFT_OPTIMIZATION_TASK, () =>
      args.runtime.useModel(ModelType.TEXT_LARGE, { prompt }),
    );
  } catch (error) {
    // error-policy:J4 A transient narrative-model failure leaves the persisted
    // structured draft visibly intact instead of fabricating generated prose.
    logger.warn(
      {
        src: "action:creative_draft",
        task: CREATIVE_DRAFT_OPTIMIZATION_TASK,
        error: error instanceof Error ? error.message : String(error),
      },
      "[CREATIVE_DRAFT] compose model call failed; returning structured draft without narrative",
    );
    return undefined;
  }
  return typeof raw === "string" ? raw.trim() : undefined;
}

function creativeDraftDocuments(
  runtime: IAgentRuntime,
): CreativeDraftDocumentService | null {
  return runtime.getService<DocumentService>("documents");
}

function isVoiceMemoAttachment(attachment: Media): boolean {
  return (
    attachment.contentType === "audio" ||
    attachment.contentType === "video" ||
    attachment.mimeType?.startsWith("audio/") === true ||
    attachment.mimeType?.startsWith("video/") === true
  );
}

async function resolveMemoTranscripts(args: {
  runtime: IAgentRuntime;
  message: Memory;
  supplied: readonly CreativeMemoTranscript[];
}): Promise<CreativeMemoTranscript[]> {
  const byId = new Map(args.supplied.map((memo) => [memo.id, memo]));
  const incoming = (args.message.content.attachments ?? []).filter(
    isVoiceMemoAttachment,
  );
  let processed = incoming;
  if (incoming.some((attachment) => !attachment.text?.trim())) {
    const processor = args.runtime.messageService?.processAttachments;
    if (!processor) {
      throw new ElizaError(
        "Voice memo transcription is unavailable because the attachment processor is not running",
        { code: "CREATIVE_DRAFT_TRANSCRIPTION_UNAVAILABLE" },
      );
    }
    processed = (
      await processor.call(args.runtime.messageService, args.runtime, incoming)
    ).filter(isVoiceMemoAttachment);
  }

  for (const attachment of processed) {
    const transcript = attachment.text?.trim();
    if (!transcript) {
      throw new ElizaError(
        `Voice memo ${attachment.filename ?? attachment.title ?? attachment.id} has no usable transcript`,
        {
          code: "CREATIVE_DRAFT_TRANSCRIPTION_EMPTY",
          context: { attachmentId: attachment.id },
        },
      );
    }
    const suppliedMemo = byId.get(attachment.id);
    byId.set(attachment.id, {
      id: attachment.id,
      transcript,
      affect: suppliedMemo?.affect,
      toneDirective: suppliedMemo?.toneDirective,
      capturedAt: suppliedMemo?.capturedAt,
    });
  }
  return [...byId.values()];
}

function ownerVoiceSourceKind(memory: Memory): OwnerVoiceSource["source"] {
  const metadata = memory.metadata as Record<string, unknown> | undefined;
  const label = [metadata?.source, metadata?.filename, metadata?.title]
    .filter((value): value is string => typeof value === "string")
    .join(" ")
    .toLowerCase();
  if (/mail|email|gmail/u.test(label)) return "sent_mail";
  if (/thread|post|tweet|social/u.test(label)) return "thread";
  if (/essay|article|blog/u.test(label)) return "essay";
  return "note";
}

async function resolveOwnerVoiceSources(args: {
  documents: CreativeDraftDocumentService;
  message: Memory;
  supplied: readonly OwnerVoiceSource[];
}): Promise<OwnerVoiceSource[]> {
  const byId = new Map(args.supplied.map((source) => [source.id, source]));
  const documents = await args.documents.listDocuments(args.message, {
    addedBy: args.message.entityId,
    limit: MAX_OWNER_VOICE_SOURCES,
  });
  for (const document of documents) {
    const metadata = document.metadata as Record<string, unknown> | undefined;
    if (metadata?.documentKind === CREATIVE_DRAFT_DOCUMENT_KIND) continue;
    const text = document.content.text?.trim();
    if (!document.id || !text) continue;
    byId.set(document.id, {
      id: document.id,
      text: truncateWellFormed(
        toWellFormedUnicode(text),
        MAX_OWNER_SOURCE_CHARS,
      ),
      source: ownerVoiceSourceKind(document),
    });
    if (byId.size >= MAX_OWNER_VOICE_SOURCES) break;
  }
  return [...byId.values()].slice(0, MAX_OWNER_VOICE_SOURCES);
}

function serializeDraft(draft: CreativeDraftArtifact): string {
  const envelope: StoredCreativeDraftEnvelope = {
    schemaVersion: 1,
    kind: CREATIVE_DRAFT_DOCUMENT_KIND,
    draft,
  };
  return JSON.stringify(envelope, null, 2);
}

function parseStoredDraft(
  content: string,
  documentId: string,
): CreativeDraftArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (cause) {
    // error-policy:J2 Preserve the malformed durable record as the cause of a
    // typed draft-load failure instead of treating it as an empty draft.
    throw new ElizaError("Stored creative draft is not valid JSON", {
      code: "CREATIVE_DRAFT_STORED_INVALID",
      cause,
      context: { documentId },
    });
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Reflect.get(parsed, "kind") !== CREATIVE_DRAFT_DOCUMENT_KIND
  ) {
    throw new ElizaError("Stored document is not a creative draft", {
      code: "CREATIVE_DRAFT_STORED_INVALID",
      context: { documentId },
    });
  }
  const draft = Reflect.get(parsed, "draft");
  if (
    typeof draft !== "object" ||
    draft === null ||
    typeof Reflect.get(draft, "id") !== "string" ||
    typeof Reflect.get(draft, "title") !== "string" ||
    !Array.isArray(Reflect.get(draft, "sections")) ||
    !isStringArray(Reflect.get(draft, "acceptedEdits")) ||
    !isStringArray(Reflect.get(draft, "vetoedPhrases")) ||
    (Reflect.get(draft, "acceptedPassages") !== undefined &&
      !isStringArray(Reflect.get(draft, "acceptedPassages")))
  ) {
    throw new ElizaError("Stored creative draft artifact is malformed", {
      code: "CREATIVE_DRAFT_STORED_INVALID",
      context: { documentId },
    });
  }
  return draft as CreativeDraftArtifact;
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

async function persistNewDraft(args: {
  runtime: IAgentRuntime;
  documents: CreativeDraftDocumentService;
  message: Memory;
  draft: CreativeDraftArtifact;
}): Promise<string> {
  const filename = `${
    args.draft.title
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9]+/gu, "-")
      .replace(/^-+|-+$/gu, "")
      .toLowerCase() || "creative-draft"
  }.creative-draft.json`;
  const content = serializeDraft(args.draft);
  let resolvedWorldId = args.message.worldId as UUID | undefined;
  if (!resolvedWorldId) {
    let room: Awaited<ReturnType<typeof args.runtime.getRoom>>;
    try {
      room = await args.runtime.getRoom(args.message.roomId as UUID);
    } catch (cause) {
      // error-policy:J2 Draft persistence requires canonical room scope; preserve the adapter failure.
      throw new ElizaError("Creative draft room lookup failed", {
        code: "CREATIVE_DRAFT_ROOM_LOOKUP_FAILED",
        context: { roomId: args.message.roomId },
        cause,
      });
    }
    if (!room?.worldId) {
      throw new ElizaError("Creative draft world resolution failed", {
        code: "CREATIVE_DRAFT_WORLD_MISSING",
        context: { roomId: args.message.roomId },
      });
    }
    resolvedWorldId = room.worldId as UUID;
  }
  const stored = await args.documents.addDocument({
    agentId: args.runtime.agentId,
    worldId: resolvedWorldId,
    roomId: args.message.roomId,
    entityId: args.message.entityId,
    clientDocumentId: "" as UUID,
    contentType: "application/json",
    originalFilename: filename,
    content,
    scope: "owner-private",
    scopedToEntityId: args.message.entityId,
    addedBy: args.message.entityId,
    addedByRole: "OWNER",
    addedFrom: "lifeops",
    metadata: {
      source: "lifeops",
      documentKind: CREATIVE_DRAFT_DOCUMENT_KIND,
      creativeDraftId: args.draft.id,
      title: args.draft.title,
      filename,
      tags: ["creative-draft", "owner-voice"],
    },
  });
  return stored.clientDocumentId;
}

async function loadPersistedDraft(args: {
  documents: CreativeDraftDocumentService;
  message: Memory;
  documentId: string;
}): Promise<CreativeDraftArtifact> {
  const document = await args.documents.getDocumentById(
    args.documentId as UUID,
    args.message,
  );
  if (!document?.content.text) {
    throw new ElizaError("Creative draft document was not found", {
      code: "CREATIVE_DRAFT_NOT_FOUND",
      context: { documentId: args.documentId },
    });
  }
  return parseStoredDraft(document.content.text, args.documentId);
}

async function findStandingDraftDocumentId(args: {
  documents: CreativeDraftDocumentService;
  message: Memory;
}): Promise<string | null> {
  const documents = await args.documents.listDocuments(args.message, {
    addedBy: args.message.entityId,
    scope: "owner-private",
    tags: ["creative-draft"],
    limit: 100,
  });
  const candidates = documents.filter((document) => {
    const metadata = document.metadata as Record<string, unknown> | undefined;
    return (
      metadata?.documentKind === CREATIVE_DRAFT_DOCUMENT_KIND &&
      document.roomId === args.message.roomId
    );
  });
  if (candidates.length > 1) {
    throw new ElizaError(
      "More than one standing creative draft exists in this conversation; supply draftDocumentId",
      {
        code: "CREATIVE_DRAFT_AMBIGUOUS",
        context: {
          roomId: args.message.roomId,
          documentIds: candidates.map((document) => document.id),
        },
      },
    );
  }
  return candidates[0]?.id ?? null;
}

async function updatePersistedDraft(args: {
  documents: CreativeDraftDocumentService;
  message: Memory;
  documentId: string;
  draft: CreativeDraftArtifact;
}): Promise<void> {
  await args.documents.updateDocument({
    documentId: args.documentId as UUID,
    content: serializeDraft(args.draft),
    message: args.message,
  });
}

function creativeDraftFailure(
  error: unknown,
  operation: Subaction,
): ActionResult {
  const code =
    error instanceof ElizaError ? error.code : "CREATIVE_DRAFT_FAILED";
  const detail = error instanceof Error ? error.message : String(error);
  logger.error({ error, operation }, `[CREATIVE_DRAFT] ${operation} failed`);
  return {
    success: false,
    text: `The owner-voice draft could not be ${operation === "compose" ? "created" : "revised"}: ${detail}`,
    data: { error: code },
  };
}

const examples: ActionExample[][] = [
  [
    {
      name: "{{name1}}",
      content: {
        text: "Turn these voice memos into an essay in my voice.",
      },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Drafted it in your voice.",
        action: ACTION_NAME,
      },
    },
  ],
  [
    {
      name: "{{name1}}",
      content: { text: "Keep the anger in the second section." },
    },
    {
      name: "{{agentName}}",
      content: {
        text: "Revised the second section.",
        action: ACTION_NAME,
      },
    },
  ],
];

export const creativeDraftAction: Action & {
  suppressPostActionContinuation?: boolean;
} = {
  name: ACTION_NAME,
  similes: SIMILE_NAMES.slice(),
  tags: [
    "domain:creative",
    "capability:compose",
    "capability:write",
    "surface:internal",
  ],
  description:
    "Draft in the owner's voice from transcribed memos and owner-authored exemplars, then iterate. Subactions: compose (build style card + draft), revise (edit a targeted section of an existing draft).",
  descriptionCompressed:
    "CREATIVE_DRAFT compose|revise; owner-voice draft from memos + exemplars",
  routingHint:
    'ghostwrite/owner-voice drafting ("write this in my voice", "turn these memos into an essay", "revise the second section") -> CREATIVE_DRAFT; a plain briefing/digest -> BRIEF; a document search/sign -> OWNER_DOCUMENTS.',
  contexts: ["creative", "documents", "voice"],
  roleGate: { minRole: "OWNER" },
  suppressPostActionContinuation: true,
  validate: async (runtime, message) => hasLifeOpsAccess(runtime, message),
  parameters: [
    {
      name: "action",
      description: "Draft op: compose | revise.",
      schema: { type: "string" as const, enum: [...SUBACTIONS] },
    },
    {
      name: "request",
      description:
        "Draft request: { title, targetForm: essay|launch_thread|narrative|memo, ownerAsk, requestedVoice? }. Required for compose.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "memos",
      description:
        "Transcribed voice memos: [{ id, transcript, affect?, toneDirective?, capturedAt? }]. Required for compose.",
      schema: { type: "array" as const, items: { type: "object" as const } },
    },
    {
      name: "ownerSources",
      description:
        "Owner-authored exemplars used to build the voice style card: [{ id, text, source: sent_mail|essay|thread|note }].",
      schema: { type: "array" as const, items: { type: "object" as const } },
    },
    {
      name: "draftDocumentId",
      description:
        "Persisted creative-draft document UUID to reload and revise. Preferred over supplying the full currentDraft.",
      schema: { type: "string" as const },
    },
    {
      name: "currentDraft",
      description:
        "Existing CreativeDraftArtifact to revise. Required for revise.",
      schema: { type: "object" as const, additionalProperties: true },
    },
    {
      name: "revision",
      description:
        "Revision to apply: { instruction, acceptedEdit?, vetoedPhrase?, replacementText?, sectionId?, sectionIndex?, revisedAt }. Required for revise.",
      schema: { type: "object" as const, additionalProperties: true },
    },
  ],
  examples,
  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state,
    options,
    callback: HandlerCallback | undefined,
  ): Promise<ActionResult> => {
    if (!(await hasLifeOpsAccess(runtime, message))) {
      const text = "Owner-voice drafting is restricted to the owner.";
      await callback?.({ text });
      return { text, success: false, data: { error: "PERMISSION_DENIED" } };
    }

    const params = getParams(options);
    const subaction = resolveSubaction(params) ?? "compose";
    const nowIso = new Date().toISOString();
    const documents = creativeDraftDocuments(runtime);
    if (!documents) {
      return {
        success: false,
        text: "Owner-voice drafts are unavailable because document storage is not running.",
        data: { error: "DOCUMENTS_SERVICE_UNAVAILABLE" },
      };
    }

    try {
      if (subaction === "revise") {
        if (!params.revision) {
          return {
            success: false,
            text: "To revise, supply the requested revision.",
            data: { error: "MISSING_REVISION_INPUT" },
          };
        }
        // Explicit revision inputs are authoritative. Only infer a standing
        // document when neither persisted identity nor a complete artifact was
        // supplied, otherwise an unrelated stored draft can replace the
        // caller's artifact or make it fail as ambiguous.
        const standingDraftDocumentId = params.draftDocumentId
          ? params.draftDocumentId
          : params.currentDraft
            ? null
            : await findStandingDraftDocumentId({ documents, message });
        const currentDraft = params.draftDocumentId
          ? await loadPersistedDraft({
              documents,
              message,
              documentId: params.draftDocumentId,
            })
          : (params.currentDraft ??
            (standingDraftDocumentId
              ? await loadPersistedDraft({
                  documents,
                  message,
                  documentId: standingDraftDocumentId,
                })
              : undefined));
        if (!currentDraft) {
          throw new ElizaError("Creative draft is unavailable", {
            code: "CREATIVE_DRAFT_NOT_FOUND",
          });
        }
        const revisedBase = applyCreativeDraftRevision(
          currentDraft,
          params.revision,
        );
        const ownerSources = await resolveOwnerVoiceSources({
          documents,
          message,
          supplied: params.ownerSources ?? [],
        });
        const styleCard = buildOwnerVoiceStyleCard(ownerSources);
        const narrative = await composeDraftNarrative({
          runtime,
          request: reconstructRequest(revisedBase),
          memos: [],
          styleCard,
          currentDraft: revisedBase,
        });
        const narrativeViolations = narrative
          ? creativeDraftNarrativeViolations(narrative, revisedBase)
          : [];
        if (narrativeViolations.length > 0) {
          logger.warn(
            {
              src: "action:creative_draft",
              draftId: revisedBase.id,
              violations: narrativeViolations,
            },
            "[CREATIVE_DRAFT] discarded narrative that violated owner revision constraints",
          );
        }
        const acceptedNarrative =
          narrative && narrativeViolations.length === 0 ? narrative : undefined;
        const revised = acceptedNarrative
          ? { ...revisedBase, narrative: acceptedNarrative }
          : revisedBase;
        const fidelity =
          acceptedNarrative !== undefined
            ? scoreOwnerVoiceFidelity(acceptedNarrative, styleCard)
            : undefined;
        const draftDocumentId =
          standingDraftDocumentId ??
          (await persistNewDraft({
            runtime,
            documents,
            message,
            draft: revised,
          }));
        if (standingDraftDocumentId) {
          await updatePersistedDraft({
            documents,
            message,
            documentId: standingDraftDocumentId,
            draft: revised,
          });
        }
        const text = acceptedNarrative ?? `Revised "${revised.title}".`;
        logger.info(
          `[CREATIVE_DRAFT] revise id=${revised.id} document=${draftDocumentId} sections=${revised.sections.length} fidelity=${fidelity ?? "n/a"}`,
        );
        await callback?.({ text, source: "action", action: ACTION_NAME });
        return {
          success: true,
          text,
          data: {
            subaction,
            draft: revised,
            draftId: revised.id,
            draftDocumentId,
            fidelity,
          },
        };
      }

      if (!params.request) {
        return {
          success: false,
          text: "To draft in your voice, tell me what you want to create.",
          data: { error: "MISSING_COMPOSE_INPUT" },
        };
      }
      const memos = await resolveMemoTranscripts({
        runtime,
        message,
        supplied: params.memos ?? [],
      });
      if (memos.length === 0) {
        return {
          success: false,
          text: "To draft in your voice, attach a voice memo or supply a transcript.",
          data: { error: "MISSING_COMPOSE_INPUT" },
        };
      }

      const ownerSources = await resolveOwnerVoiceSources({
        documents,
        message,
        supplied: params.ownerSources ?? [],
      });
      const styleCard = buildOwnerVoiceStyleCard(ownerSources);
      const draftBase = createCreativeDraftArtifact({
        request: params.request,
        memos,
        styleCard,
        nowIso,
      });
      const narrative = await composeDraftNarrative({
        runtime,
        request: params.request,
        memos,
        styleCard,
        currentDraft: draftBase,
      });
      const draft = narrative ? { ...draftBase, narrative } : draftBase;
      const fidelity =
        narrative !== undefined
          ? scoreOwnerVoiceFidelity(narrative, styleCard)
          : undefined;
      const draftDocumentId = await persistNewDraft({
        runtime,
        documents,
        message,
        draft,
      });
      const text = narrative ?? `Drafted "${draft.title}" in your voice.`;
      logger.info(
        `[CREATIVE_DRAFT] compose id=${draft.id} document=${draftDocumentId} sections=${draft.sections.length} styleSources=${styleCard.sourceIds.length} fidelity=${fidelity ?? "n/a"}`,
      );
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: true,
        text,
        data: {
          subaction,
          draft,
          draftId: draft.id,
          draftDocumentId,
          styleCard,
          fidelity,
        },
      };
    } catch (error) {
      return creativeDraftFailure(error, subaction);
    }
  },
};

/**
 * A revise turn no longer carries the original request, but the compose pass
 * needs one. Reconstruct it from the durable fields the artifact preserves.
 */
function reconstructRequest(
  draft: CreativeDraftArtifact,
): CreativeDraftRequest {
  return {
    title: draft.title,
    targetForm: draft.targetForm,
    ownerAsk: `Revise the standing "${draft.title}" draft, keeping accepted edits and honoring vetoed phrasing.`,
  };
}
