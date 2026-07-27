/**
 * Action-construction seam for source-grounded school notice ingestion.
 *
 * Hosts inject their owner authorization policy and register the runtime
 * service. Every verb stops at immutable capture, reconciliation, or proposed
 * action bundles; there is deliberately no send, purchase, submit, or calendar
 * mutation verb.
 */
import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
} from "@elizaos/core";
import { resolveActionArgs, type SubactionsMap } from "@elizaos/core";
import {
  getSchoolSourceFactRuntimeService,
  type SchoolSourceFactRuntimeService,
} from "./service.js";
import {
  type IngestSchoolNoticeInput,
  normalizeResponsibilityAssignmentInput,
  normalizeSchoolNoticeExtraction,
  normalizeSourceArtifactInput,
  normalizeSourceFactCandidate,
  normalizeSourceVersion,
  SchoolSourceFactError,
  SOURCE_AUTHORITY_CLASSES,
} from "./types.js";

const ACTION_NAME = "SCHOOL_SOURCES";
const SCHOOL_SOURCE_SUBACTIONS = [
  "capture_candidates",
  "ingest_notice",
  "reconcile_notice",
] as const;
type SchoolSourceSubaction = (typeof SCHOOL_SOURCE_SUBACTIONS)[number];

const SUBACTIONS: SubactionsMap<SchoolSourceSubaction> = {
  capture_candidates: {
    description:
      "Persist separate, immutable proposed facts from one voice, email, document, calendar, portal, or activity-source snapshot.",
    descriptionCompressed:
      "capture separate immutable source facts; no external effects",
    required: ["artifact", "candidates"],
  },
  ingest_notice: {
    description:
      "Resolve a child conservatively, preserve a school notice revision, reconcile corrections or cancellation, and create a safe action bundle.",
    descriptionCompressed:
      "ingest school notice + child resolution + correction + safe bundle",
    required: ["input"],
  },
  reconcile_notice: {
    description:
      "Recompute one notice from all durable source revisions and supersede stale action bundles.",
    descriptionCompressed:
      "recompute notice from all revisions; supersede stale bundles",
    required: ["noticeKey"],
  },
};

export interface SchoolSourceActionDependencies {
  authorize(runtime: IAgentRuntime, message: Memory): Promise<boolean>;
  getService?(runtime: IAgentRuntime): SchoolSourceFactRuntimeService | null;
}

function objectValue(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SchoolSourceFactError(
      `${field} must be an object`,
      "SCHOOL_INVALID_CONTRACT",
      { field },
    );
  }
  return value as Record<string, unknown>;
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SchoolSourceFactError(
      `${field} must be a non-empty string`,
      "SCHOOL_INVALID_CONTRACT",
      { field },
    );
  }
  return value.trim();
}

function serviceFor(
  runtime: IAgentRuntime,
  deps: SchoolSourceActionDependencies,
): SchoolSourceFactRuntimeService {
  const service =
    deps.getService?.(runtime) ?? getSchoolSourceFactRuntimeService(runtime);
  if (!service) {
    throw new SchoolSourceFactError(
      "School source-fact runtime service is unavailable",
      "SCHOOL_GRAPH_UNAVAILABLE",
      { agentId: runtime.agentId },
    );
  }
  return service;
}

async function complete(
  callback: HandlerCallback | undefined,
  result: ActionResult,
): Promise<ActionResult> {
  if (result.text) await callback?.({ text: result.text });
  return result;
}

function ingestInput(value: unknown): IngestSchoolNoticeInput {
  const record = objectValue(value, "input");
  const confidence = record.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new SchoolSourceFactError(
      "input.confidence must be between 0 and 1",
      "SCHOOL_INVALID_CONTRACT",
      { field: "input.confidence" },
    );
  }
  const authorityText = requiredText(record.authority, "input.authority");
  const authority = SOURCE_AUTHORITY_CLASSES.find(
    (candidate) => candidate === authorityText,
  );
  if (!authority) {
    throw new SchoolSourceFactError(
      "input.authority has an unsupported value",
      "SCHOOL_INVALID_CONTRACT",
      { authority: authorityText },
    );
  }
  return {
    artifact: normalizeSourceArtifactInput(record.artifact),
    extraction: normalizeSchoolNoticeExtraction(record.extraction),
    confidence,
    authority,
    version: normalizeSourceVersion(record.version, "input.version"),
    extractorId: requiredText(record.extractorId, "input.extractorId"),
    extractorVersion: requiredText(
      record.extractorVersion,
      "input.extractorVersion",
    ),
    responsibility:
      record.responsibility === null || record.responsibility === undefined
        ? null
        : normalizeResponsibilityAssignmentInput(record.responsibility),
  };
}

export function createSchoolSourceFactAction(
  deps: SchoolSourceActionDependencies,
): Action {
  return {
    name: ACTION_NAME,
    similes: [
      "SCHOOL_NOTICE",
      "SCHOOL_EMAIL",
      "ACTIVITY_NOTICE",
      "FIELD_TRIP_FORM",
    ],
    tags: [
      "domain:school",
      "domain:calendar",
      "capability:read",
      "capability:write",
      "surface:internal",
    ],
    description:
      "Capture source-grounded school/activity facts, resolve the correct child, reconcile corrections/cancellations, and propose approval-classified action bundles. This action never sends, purchases, submits, or mutates calendars.",
    descriptionCompressed:
      "school source facts|child disambiguation|corrections|safe proposed bundles; no external effects",
    routingHint:
      "school/activity email, PDF, ICS, portal, or noisy voice extraction -> SCHOOL_SOURCES; actual send/purchase/calendar write remains in its approval-gated owner action",
    contexts: ["general", "calendar", "tasks", "documents", "inbox"],
    roleGate: { minRole: "OWNER" },
    suppressPostActionContinuation: true,
    toolSchemaStrict: false,
    validate: deps.authorize,
    parameters: [
      {
        name: "action",
        description: "School source operation.",
        required: true,
        schema: {
          type: "string",
          enum: [...SCHOOL_SOURCE_SUBACTIONS],
        },
      },
      {
        name: "artifact",
        description:
          "Immutable source snapshot provenance for capture_candidates.",
        subactions: ["capture_candidates"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "candidates",
        description:
          "Separate extractor candidates; each becomes an immutable proposed source fact.",
        subactions: ["capture_candidates"],
        schema: {
          type: "array",
          items: { type: "object", additionalProperties: true },
        },
      },
      {
        name: "input",
        description:
          "School notice artifact, extraction, authority/version, confidence, and optional structural C/P/E/M assignment.",
        subactions: ["ingest_notice"],
        schema: { type: "object", additionalProperties: true },
      },
      {
        name: "noticeKey",
        description: "Stable logical school notice key.",
        subactions: ["reconcile_notice"],
        schema: { type: "string", minLength: 1 },
      },
    ],
    handler: async (runtime, message, state, options, callback) => {
      if (!(await deps.authorize(runtime, message))) {
        return complete(callback, {
          success: false,
          text: "School source operations are restricted to the owner.",
          data: { error: "PERMISSION_DENIED" },
        });
      }
      const resolved = await resolveActionArgs<
        SchoolSourceSubaction,
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
            error: "MISSING_SCHOOL_SOURCE_PARAMETERS",
            missing: resolved.missing,
          },
        });
      }
      const service = serviceFor(runtime, deps);
      if (resolved.subaction === "capture_candidates") {
        const candidatesValue = resolved.params.candidates;
        if (!Array.isArray(candidatesValue)) {
          throw new SchoolSourceFactError(
            "candidates must be an array",
            "SCHOOL_INVALID_CONTRACT",
          );
        }
        const result = await service.captureCandidates(
          normalizeSourceArtifactInput(resolved.params.artifact),
          candidatesValue.map(normalizeSourceFactCandidate),
        );
        return complete(callback, {
          success: true,
          text:
            `Captured ${result.sourceFacts.length} separate proposed source fact(s). ` +
            "No message, purchase, submission, or calendar mutation was performed.",
          data: {
            action: resolved.subaction,
            artifactId: result.artifact.id,
            sourceFactIds: result.sourceFacts.map((fact) => fact.id),
          },
        });
      }
      if (resolved.subaction === "ingest_notice") {
        const result = await service.ingestSchoolNotice(
          ingestInput(resolved.params.input),
        );
        return complete(callback, {
          success: true,
          text:
            `Captured school notice ${result.noticeResolution.noticeKey} as ` +
            `${result.noticeResolution.state}; created action bundle ${result.actionBundle.id}. ` +
            "All consequential items remain approval-gated proposals.",
          data: {
            action: resolved.subaction,
            artifactId: result.artifact.id,
            sourceFactId: result.sourceFact.id,
            noticeState: result.noticeResolution.state,
            actionBundleId: result.actionBundle.id,
            childResolution: result.childResolution.status,
          },
        });
      }
      const result = await service.reconcileNotice(
        requiredText(resolved.params.noticeKey, "noticeKey"),
      );
      return complete(callback, {
        success: true,
        text:
          `Reconciled ${result.resolution.noticeKey} as ${result.resolution.state}; ` +
          `current action bundle is ${result.bundle.id}.`,
        data: {
          action: resolved.subaction,
          noticeState: result.resolution.state,
          actionBundleId: result.bundle.id,
        },
      });
    },
    examples: [],
  };
}
