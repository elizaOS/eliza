/**
 * `CREATIVE_DRAFT` action — owner-voice drafting from transcribed memos and
 * owner-authored exemplars. It is the real consumer of the creative-draft
 * primitives (`src/lifeops/creative-draft/index.ts`): it builds an owner-voice
 * style card, composes or revises a structured draft artifact, runs one live
 * model pass through the sanctioned `creative_draft` OptimizedPromptService
 * task, and scores the result's owner-voice fidelity.
 *
 * Subactions:
 *   - `compose` — build a style card from exemplars + memos and draft in the
 *     owner's voice, returning a `CreativeDraftArtifact` and a fidelity score.
 *   - `revise`  — apply a `CreativeDraftRevision` to a supplied draft artifact
 *     (targeting the section named by `sectionId`/`sectionIndex`), then
 *     re-compose the narrative.
 *
 * Drafts are returned to the caller, never persisted here — work-thread and
 * document surfaces own storage. Owner-only via `hasLifeOpsAccess`.
 */

import type {
  Action,
  ActionExample,
  ActionResult,
  HandlerCallback,
  HandlerOptions,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { logger, ModelType, runWithTrajectoryPurpose } from "@elizaos/core";
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
  currentDraft?: CreativeDraftArtifact;
  revision?: CreativeDraftRevision;
}

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

    if (subaction === "revise") {
      if (!params.currentDraft || !params.revision) {
        return {
          success: false,
          text: "To revise, supply both the current draft and the revision.",
          data: { error: "MISSING_REVISION_INPUT" },
        };
      }
      const revised = applyCreativeDraftRevision(
        params.currentDraft,
        params.revision,
      );
      const styleCard = buildOwnerVoiceStyleCard(params.ownerSources ?? []);
      const narrative = await composeDraftNarrative({
        runtime,
        request: reconstructRequest(revised),
        memos: params.memos ?? [],
        styleCard,
        currentDraft: revised,
      });
      const fidelity =
        narrative !== undefined
          ? scoreOwnerVoiceFidelity(narrative, styleCard)
          : undefined;
      const text = narrative ?? `Revised "${revised.title}".`;
      logger.info(
        `[CREATIVE_DRAFT] revise id=${revised.id} sections=${revised.sections.length} fidelity=${fidelity ?? "n/a"}`,
      );
      await callback?.({ text, source: "action", action: ACTION_NAME });
      return {
        success: true,
        text,
        data: { subaction, draft: revised, draftId: revised.id, fidelity },
      };
    }

    if (!params.request || !params.memos || params.memos.length === 0) {
      return {
        success: false,
        text: "To draft in your voice, tell me the request and the voice memos to work from.",
        data: { error: "MISSING_COMPOSE_INPUT" },
      };
    }

    const styleCard = buildOwnerVoiceStyleCard(params.ownerSources ?? []);
    const draft = createCreativeDraftArtifact({
      request: params.request,
      memos: params.memos,
      styleCard,
      nowIso,
    });
    const narrative = await composeDraftNarrative({
      runtime,
      request: params.request,
      memos: params.memos,
      styleCard,
      currentDraft: draft,
    });
    const fidelity =
      narrative !== undefined
        ? scoreOwnerVoiceFidelity(narrative, styleCard)
        : undefined;
    const text = narrative ?? `Drafted "${draft.title}" in your voice.`;
    logger.info(
      `[CREATIVE_DRAFT] compose id=${draft.id} sections=${draft.sections.length} styleSources=${styleCard.sourceIds.length} fidelity=${fidelity ?? "n/a"}`,
    );
    await callback?.({ text, source: "action", action: ACTION_NAME });
    return {
      success: true,
      text,
      data: {
        subaction,
        draft,
        draftId: draft.id,
        styleCard,
        fidelity,
      },
    };
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
