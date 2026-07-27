/**
 * Authenticated action seam for family voice proposals and child-week
 * projection. Transcript text may supply evidence and candidate summaries, but
 * runtime identity, trusted source adapters, and structural policy decide
 * authorization; this action performs no send, purchase, or calendar mutation.
 */
import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type IAgentRuntime,
  type Memory,
  resolveActionArgs,
  type SubactionsMap,
} from "@elizaos/core";
import type { AuthenticatedMessageSpeakerAttestation } from "./authenticated-speaker-verifier.js";
import {
  type FamilyCommunicationsService,
  getFamilyCommunicationsService,
} from "./service.js";
import {
  FAMILY_COMMUNICATIONS_POLICY_VERSION,
  FamilyCommunicationsError,
  type FamilyWeekItemInput,
  isVoiceIntentKind,
  requireFamilyInteger,
  requireFamilyText,
  requireFamilyTimestamp,
  type VoiceIntentCandidateInput,
} from "./types.js";

const ACTION_NAME = "FAMILY_COMMUNICATIONS";
const SUBACTIONS = {
  capture_voice_bundle: {
    description:
      "Separate an authenticated message transcript into typed family intent proposals. This records proposals only and performs no external effect.",
    descriptionCompressed:
      "authenticated multi-intent family proposal capture; no execution",
    required: ["candidates"],
  },
  child_week: {
    description:
      "Project a child-safe week from trusted structurally scoped source references.",
    descriptionCompressed:
      "child pickup, packing, school events, and family logistics only",
    required: ["childEntityId", "windowStartsAt", "windowEndsAt", "sourceRefs"],
  },
} satisfies SubactionsMap<"capture_voice_bundle" | "child_week">;

export interface FamilyCommunicationsActionDependencies {
  resolveAuthenticatedPrincipal(
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<string | null>;
  issueSpeakerAttestation(
    runtime: IAgentRuntime,
    message: Memory,
  ): Promise<AuthenticatedMessageSpeakerAttestation>;
  resolveWeekItems(input: {
    runtime: IAgentRuntime;
    principalEntityId: string;
    childEntityId: string;
    windowStartsAt: string;
    windowEndsAt: string;
    sourceRefs: readonly string[];
  }): Promise<readonly FamilyWeekItemInput[]>;
  getService?(runtime: IAgentRuntime): FamilyCommunicationsService | null;
}

async function complete(
  callback: HandlerCallback | undefined,
  result: ActionResult,
): Promise<ActionResult> {
  if (result.text) await callback?.({ text: result.text });
  return result;
}

function stringArray(
  value: unknown,
  field: string,
  options: { allowEmpty?: boolean } = {},
): string[] {
  if (
    !Array.isArray(value) ||
    value.some((entry) => typeof entry !== "string")
  ) {
    throw new FamilyCommunicationsError(
      `${field} must be an array of source references`,
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { field },
    );
  }
  const values = Array.from(
    new Set(value.map((entry) => requireFamilyText(entry, field, 500))),
  );
  if (values.length === 0 && options.allowEmpty !== true) {
    throw new FamilyCommunicationsError(
      `${field} must contain at least one trusted source reference`,
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { field },
    );
  }
  return values;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new FamilyCommunicationsError(
      `${field} must be an object`,
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
      { field },
    );
  }
  return value as Record<string, unknown>;
}

function voiceCandidates(
  value: unknown,
  transcript: string,
  messageId: string,
): VoiceIntentCandidateInput[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new FamilyCommunicationsError(
      "candidates must contain 1-20 separated intent proposals",
      "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
    );
  }
  return value.map((candidateValue, index) => {
    const candidate = objectValue(candidateValue, `candidates.${index}`);
    if (!isVoiceIntentKind(candidate.kind)) {
      throw new FamilyCommunicationsError(
        `candidates.${index}.kind is unsupported`,
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { kind: candidate.kind },
      );
    }
    const sourceSpan = objectValue(
      candidate.sourceSpan,
      `candidates.${index}.sourceSpan`,
    );
    const start = requireFamilyInteger(
      sourceSpan.start,
      `candidates.${index}.sourceSpan.start`,
    );
    const end = requireFamilyInteger(
      sourceSpan.end,
      `candidates.${index}.sourceSpan.end`,
      1,
    );
    if (end <= start || end > transcript.length) {
      throw new FamilyCommunicationsError(
        `candidates.${index}.sourceSpan is outside the authenticated message text`,
        "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
        { start, end, transcriptLength: transcript.length },
      );
    }
    return {
      candidateId: `voice-candidate:${messageId}:${index + 1}`,
      kind: candidate.kind,
      summary: requireFamilyText(
        candidate.summary,
        `candidates.${index}.summary`,
        1_000,
      ),
      subjectEntityIds: stringArray(
        candidate.subjectEntityIds,
        `candidates.${index}.subjectEntityIds`,
        { allowEmpty: true },
      ),
      sourceSpan: { start, end },
    };
  });
}

export function createFamilyCommunicationsAction(
  deps: FamilyCommunicationsActionDependencies,
): Action {
  return {
    name: ACTION_NAME,
    similes: [
      "CAPTURE_FAMILY_VOICE",
      "CHILD_WEEK",
      "FAMILY_WEEK",
      "KIDS_SCHEDULE",
    ],
    tags: [
      "domain:household",
      "domain:calendar",
      "capability:read",
      "capability:write",
      "surface:internal",
    ],
    description:
      "Capture authenticated multi-intent family requests as non-executing proposals, or create a child-safe week view from trusted source references. Adult and teen private content is structurally omitted.",
    descriptionCompressed:
      "authenticated family proposals (no execution) or child-safe week projection",
    routingHint:
      "separate a spoken family request into proposals, or show a child their safe weekly logistics -> FAMILY_COMMUNICATIONS",
    contexts: ["general", "calendar", "tasks"],
    suppressPostActionContinuation: true,
    toolSchemaStrict: false,
    validate: async (runtime, message) =>
      (await deps.resolveAuthenticatedPrincipal(runtime, message)) !== null,
    parameters: [
      {
        name: "action",
        description: "Family-communications verb.",
        required: true,
        schema: {
          type: "string",
          enum: ["capture_voice_bundle", "child_week"],
        },
      },
      {
        name: "candidates",
        description:
          "Separated typed proposals grounded by exact character spans in the authenticated message text.",
        subactions: ["capture_voice_bundle"],
        schema: {
          type: "array",
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [
                  "calendar_lookup",
                  "calendar_change",
                  "reminder_draft",
                  "message_draft",
                  "message_send",
                  "purchase",
                  "private_record_read",
                  "household_note",
                ],
              },
              summary: { type: "string", minLength: 1 },
              subjectEntityIds: {
                type: "array",
                items: { type: "string", minLength: 1 },
              },
              sourceSpan: {
                type: "object",
                properties: {
                  start: { type: "integer", minimum: 0 },
                  end: { type: "integer", minimum: 1 },
                },
                required: ["start", "end"],
                additionalProperties: false,
              },
            },
            required: ["kind", "summary", "subjectEntityIds", "sourceSpan"],
            additionalProperties: false,
          },
        },
      },
      {
        name: "childEntityId",
        description: "Canonical entity ID of the authenticated child.",
        subactions: ["child_week"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "windowStartsAt",
        description: "Inclusive ISO-8601 week-window start.",
        subactions: ["child_week"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "windowEndsAt",
        description: "Exclusive ISO-8601 week-window end.",
        subactions: ["child_week"],
        schema: { type: "string", minLength: 1 },
      },
      {
        name: "sourceRefs",
        description:
          "Trusted item-set references; currently household:child-week. Never raw event text.",
        subactions: ["child_week"],
        schema: {
          type: "array",
          items: { type: "string", minLength: 1 },
        },
      },
    ],
    handler: async (runtime, message, state, options, callback) => {
      const principalEntityId = await deps.resolveAuthenticatedPrincipal(
        runtime,
        message,
      );
      if (!principalEntityId) {
        return complete(callback, {
          success: false,
          text: "A verified household identity is required for this view.",
          data: { error: "PERMISSION_DENIED" },
        });
      }
      const resolved = await resolveActionArgs<
        "capture_voice_bundle" | "child_week",
        Record<string, unknown>
      >({
        runtime,
        message,
        state,
        options,
        actionName: ACTION_NAME,
        subactions: SUBACTIONS,
      });
      if (!resolved.ok) {
        return complete(callback, {
          success: false,
          text: resolved.clarification,
          data: {
            error: "MISSING_FAMILY_COMMUNICATIONS_PARAMETERS",
            missing: resolved.missing,
          },
        });
      }
      const service =
        deps.getService?.(runtime) ?? getFamilyCommunicationsService(runtime);
      if (!service) {
        throw new FamilyCommunicationsError(
          "Family-communications runtime service is unavailable",
          "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
          { agentId: runtime.agentId },
        );
      }
      if (resolved.subaction === "capture_voice_bundle") {
        if (!message.id) {
          throw new FamilyCommunicationsError(
            "Authenticated message capture requires a persisted message ID",
            "FAMILY_COMMUNICATIONS_INVALID_CONTRACT",
          );
        }
        const transcript = requireFamilyText(
          message.content.text,
          "message.content.text",
          32_768,
        );
        const issued = await deps.issueSpeakerAttestation(runtime, message);
        if (issued.principalEntityId !== principalEntityId) {
          throw new FamilyCommunicationsError(
            "Authenticated principal changed during speaker attestation",
            "FAMILY_COMMUNICATIONS_ACCESS_DENIED",
          );
        }
        const result = await service.ingestVoiceBundle({
          schemaVersion: FAMILY_COMMUNICATIONS_POLICY_VERSION,
          bundleId: `family-voice:${message.id}`,
          turnId: `runtime-message:${message.id}`,
          capturedAt: issued.capturedAt,
          transcript,
          claimedPrincipalEntityId: principalEntityId,
          speakerAttestation: issued.attestation,
          candidates: voiceCandidates(
            resolved.params.candidates,
            transcript,
            message.id,
          ),
        });
        return complete(callback, {
          success: true,
          text:
            result.bundle.authorizationState === "authorized"
              ? "The family request was separated into proposals; nothing was sent, changed, or purchased."
              : "The family request was quarantined because speaker authorization could not be verified.",
          data: {
            bundle: result.bundle,
            candidates: result.candidates,
            replayed: result.replayed,
            externalEffectsPerformed: false,
          },
        });
      }
      const childEntityId = requireFamilyText(
        resolved.params.childEntityId,
        "childEntityId",
        200,
      );
      const windowStartsAt = requireFamilyTimestamp(
        resolved.params.windowStartsAt,
        "windowStartsAt",
      );
      const windowEndsAt = requireFamilyTimestamp(
        resolved.params.windowEndsAt,
        "windowEndsAt",
      );
      const sourceRefs = stringArray(resolved.params.sourceRefs, "sourceRefs");
      const items = await deps.resolveWeekItems({
        runtime,
        principalEntityId,
        childEntityId,
        windowStartsAt,
        windowEndsAt,
        sourceRefs,
      });
      const projection = await service.projectChildWeek({
        principalEntityId,
        childEntityId,
        windowStartsAt,
        windowEndsAt,
        items,
      });
      return complete(callback, {
        success: true,
        text: "The child-safe week view is ready.",
        data: {
          projection,
          omittedCount: Object.values(projection.omissions).reduce(
            (total, count) => total + count,
            0,
          ),
        },
      });
    },
  };
}
