/**
 * Builds the redacted, typed result envelope shared by durable child events and
 * the orchestrator task-detail API. The envelope is additive: task/session
 * records keep their existing schema while event `data.childTerminalResult`
 * captures the point-in-time result and the detail DTO exposes the latest view.
 */

import { redactSensitiveText } from "@elizaos/core";
import {
  type CompletionEnvelope,
  parseCompletionEnvelope,
} from "./completion-envelope.js";
import type {
  ArtifactVerificationStatus,
  OrchestratorTaskDocument,
  OrchestratorTaskEvent,
  OrchestratorTaskStatus,
} from "./orchestrator-task-types.js";

export type ChildTerminalStatus =
  | "completed"
  | "failed"
  | "blocked"
  | "awaiting_user"
  | "cancelled";

export type ChildVerificationStatus =
  | "pending"
  | "passed"
  | "failed"
  | "inconclusive"
  | "not_applicable";

export type ChildDeliveryStatus =
  | "pending"
  | "delivered"
  | "failed"
  | "not_requested"
  | "unknown";

export interface ChildTerminalArtifactRef {
  id: string;
  type: string;
  ref: string;
  verificationStatus: ArtifactVerificationStatus;
}

export interface ChildTerminalResultEnvelope {
  schemaVersion: 1;
  status: ChildTerminalStatus;
  summary: string;
  evidence: {
    required: boolean;
    present: boolean;
    sufficient: boolean;
    summary?: string;
    artifactRefs: ChildTerminalArtifactRef[];
  };
  blocker?: string;
  question?: string;
  requiresUserInput: boolean;
  lineage: {
    taskId: string;
    sessionId?: string;
    parentTaskId?: string;
    parentSessionId?: string;
    traceId?: string;
    parentTrajectoryStepId?: string;
    childTrajectoryIds: string[];
  };
  verificationStatus: ChildVerificationStatus;
  deliveryStatus: ChildDeliveryStatus;
}

const TERMINAL_EVENTS = new Set([
  "task_complete",
  "error",
  "blocked",
  "login_required",
  "QUESTION_FOR_TASK_CREATOR",
  "stopped",
  "cancelled",
]);

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = redactSensitiveText(value).trim();
  return trimmed || undefined;
}

function withoutAbsolutePaths(value: string): string {
  return value.replace(
    /(^|[\s("'`])((?:\/|[A-Za-z]:\\)[^\s)"',;]+)/g,
    (_match, prefix: string, path: string) =>
      `${prefix}${path.split(/[\\/]/).filter(Boolean).at(-1) ?? "artifact"}`,
  );
}

function summaryText(value: unknown): string | undefined {
  const safe = text(value);
  return safe ? withoutAbsolutePaths(safe) : undefined;
}

function safeArtifactRef(value: unknown): string | undefined {
  const safe = text(value);
  if (!safe) return undefined;
  try {
    const url = new URL(safe);
    if (url.protocol === "http:" || url.protocol === "https:") {
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.toString();
    }
  } catch {
    // error-policy:J3 artifact references may be paths or opaque ids, not URLs.
  }
  if (/^(?:\/|[A-Za-z]:\\)/.test(safe)) {
    return safe.split(/[\\/]/).filter(Boolean).at(-1);
  }
  return withoutAbsolutePaths(safe);
}

function sameClaim(left: string, right: string): boolean {
  const normalize = (value: string) => value.replace(/\\/g, "/");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.endsWith(`/${b}`) || b.endsWith(`/${a}`);
}

function completionEvidenceSummary(envelope: CompletionEnvelope): string {
  const passedTests = envelope.testResults.filter(
    (result) => result.exitCode === 0,
  ).length;
  const metCriteria = envelope.acceptanceCriteriaStatus.filter(
    (criterion) => criterion.met,
  ).length;
  const testDetails = envelope.testResults
    .map(
      (result) =>
        `${result.exitCode === 0 ? "passed" : "failed"}: ${summaryText(result.summary) ?? "no summary"}`,
    )
    .join("; ");
  const criterionDetails = envelope.acceptanceCriteriaStatus
    .map(
      (criterion) =>
        `${criterion.met ? "met" : "unmet"}: ${summaryText(criterion.criterion) ?? "criterion"} (${summaryText(criterion.evidence) ?? "no evidence"})`,
    )
    .join("; ");
  return [
    `Tests ${passedTests}/${envelope.testResults.length} passed${testDetails ? ` (${testDetails})` : ""}.`,
    `Criteria ${metCriteria}/${envelope.acceptanceCriteriaStatus.length} met${criterionDetails ? ` (${criterionDetails})` : ""}.`,
  ].join(" ");
}

function completionArtifactRefs(
  envelope: CompletionEnvelope,
): ChildTerminalArtifactRef[] {
  const missing = envelope.missingArtifacts ?? [];
  const verified = envelope.verifiedChangedFiles ?? [];
  const statusForClaim = (
    claim: string,
    verifiedStatus?: ArtifactVerificationStatus,
  ): ArtifactVerificationStatus => {
    if (verifiedStatus) return verifiedStatus;
    if (missing.some((candidate) => sameClaim(candidate, claim)))
      return "failed";
    return envelope.artifactsVerified === true ? "passed" : "unknown";
  };
  const refs: ChildTerminalArtifactRef[] = [];
  const append = (
    type: string,
    claim: string,
    index: number,
    verificationStatus?: ArtifactVerificationStatus,
  ): void => {
    const ref = safeArtifactRef(claim);
    if (!ref) return;
    refs.push({
      id: `completion:${type}:${index}`,
      type,
      ref,
      verificationStatus: statusForClaim(claim, verificationStatus),
    });
  };
  verified.forEach((file, index) => {
    append(
      "verified_file",
      file.path,
      index,
      file.exists ? "passed" : "failed",
    );
  });
  envelope.filesChanged
    .filter((claim) => !verified.some((file) => sameClaim(file.path, claim)))
    .forEach((claim, index) => {
      append("claimed_file", claim, index);
    });
  envelope.screenshotPaths.forEach((claim, index) => {
    append("screenshot", claim, index);
  });
  if (envelope.trajectoryPath) {
    append("trajectory", envelope.trajectoryPath, 0);
  }
  return refs;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const safe = text(entry);
        return safe ? [safe] : [];
      })
    : [];
}

function deliveryStatus(value: unknown): ChildDeliveryStatus {
  return value === "pending" ||
    value === "delivered" ||
    value === "failed" ||
    value === "not_requested" ||
    value === "unknown"
    ? value
    : "unknown";
}

function routingKind(data: Record<string, unknown>): string | undefined {
  return text(data.routingKind ?? data.type ?? data.kind ?? data.purpose)
    ?.toUpperCase()
    .trim();
}

function statusForEvent(
  eventType: string,
  data: Record<string, unknown>,
): ChildTerminalStatus {
  if (eventType === "task_complete") return "completed";
  if (eventType === "error") return "failed";
  if (eventType === "stopped" || eventType === "cancelled") return "cancelled";
  const route = routingKind(data);
  // An explicit coordination route means the parent/orchestrator should answer
  // even when the child phrased its blocker as a question.
  if (route === "AGENT_COORDINATION") return "blocked";
  if (
    eventType === "login_required" ||
    eventType === "QUESTION_FOR_TASK_CREATOR" ||
    route === "QUESTION_FOR_TASK_CREATOR" ||
    text(data.question)
  ) {
    return "awaiting_user";
  }
  return "blocked";
}

function statusForTask(
  taskStatus: OrchestratorTaskStatus,
  eventStatus: ChildTerminalStatus,
): ChildTerminalStatus {
  if (taskStatus === "done") return "completed";
  if (taskStatus === "failed") return "failed";
  if (taskStatus === "waiting_on_user") return "awaiting_user";
  if (taskStatus === "interrupted") return "cancelled";
  if (taskStatus === "blocked") return "blocked";
  return eventStatus;
}

function verificationFor(
  taskStatus: OrchestratorTaskStatus,
  events: readonly OrchestratorTaskEvent[],
  terminalStatus: ChildTerminalStatus,
): ChildVerificationStatus {
  if (taskStatus === "done") return "passed";
  if (taskStatus === "validating") return "pending";
  const latestVerification = [...events]
    .reverse()
    .find((event) =>
      [
        "validation_passed",
        "validation_failed",
        "goal_verify_inconclusive",
        "independent_verify_inconclusive",
        "auto_verify_inconclusive",
      ].includes(event.eventType),
    );
  if (latestVerification?.eventType === "validation_passed") return "passed";
  if (latestVerification?.eventType === "validation_failed") return "failed";
  if (latestVerification?.eventType.includes("inconclusive")) {
    return "inconclusive";
  }
  return terminalStatus === "completed" ? "pending" : "not_applicable";
}

function latestTerminalEvent(
  events: readonly OrchestratorTaskEvent[],
  taskStatus: OrchestratorTaskStatus,
): OrchestratorTaskEvent | undefined {
  const terminal = [...events]
    .filter((event) => TERMINAL_EVENTS.has(event.eventType))
    .sort(
      (a, b) =>
        (Number.isFinite(b.timestamp) ? b.timestamp : 0) -
        (Number.isFinite(a.timestamp) ? a.timestamp : 0),
    );
  const preferred =
    taskStatus === "done" || taskStatus === "validating"
      ? ["task_complete"]
      : taskStatus === "failed"
        ? ["error"]
        : taskStatus === "interrupted"
          ? ["cancelled", "stopped"]
          : taskStatus === "waiting_on_user"
            ? ["QUESTION_FOR_TASK_CREATOR", "login_required", "blocked"]
            : taskStatus === "blocked"
              ? ["blocked", "QUESTION_FOR_TASK_CREATOR"]
              : [];
  return (
    terminal.find((event) => preferred.includes(event.eventType)) ?? terminal[0]
  );
}

/** Build the latest terminal child result, or undefined before any terminal event. */
export function deriveChildTerminalResult(
  doc: OrchestratorTaskDocument,
  eventOverride?: Pick<
    OrchestratorTaskEvent,
    "eventType" | "sessionId" | "summary" | "data" | "timestamp"
  >,
): ChildTerminalResultEnvelope | undefined {
  const event =
    eventOverride ?? latestTerminalEvent(doc.events, doc.task.status);
  if (!event || !TERMINAL_EVENTS.has(event.eventType)) return undefined;
  const data = record(event.data);
  const sessionId = event.sessionId;
  const session = sessionId
    ? doc.sessions.find((candidate) => candidate.sessionId === sessionId)
    : undefined;
  const eventStatus = statusForEvent(event.eventType, data);
  const status = statusForTask(doc.task.status, eventStatus);
  const isQuestion = eventStatus === "awaiting_user";
  const question = isQuestion
    ? text(data.question ?? data.message ?? data.prompt ?? event.summary)
    : undefined;
  const blocker =
    status === "blocked" || status === "awaiting_user"
      ? text(data.blocker ?? data.message ?? event.summary)
      : undefined;
  const rawCompletion =
    typeof data.response === "string"
      ? data.response
      : typeof data.finalText === "string"
        ? data.finalText
        : undefined;
  const completion =
    event.eventType === "task_complete" && rawCompletion
      ? parseCompletionEnvelope(rawCompletion)
      : { present: false as const };
  const completionEnvelope =
    completion.present && completion.ok ? completion.envelope : undefined;
  const summary =
    summaryText(
      completionEnvelope?.diffSummary ??
        data.response ??
        data.finalText ??
        data.message ??
        event.summary,
    ) ?? "Child agent returned without a summary.";
  const durableArtifactRefs = doc.artifacts
    .filter(
      (artifact) =>
        !sessionId || !artifact.sessionId || artifact.sessionId === sessionId,
    )
    .flatMap((artifact) => {
      const ref = safeArtifactRef(artifact.uri ?? artifact.path);
      return ref
        ? [
            {
              id: artifact.id,
              type: artifact.artifactType,
              ref,
              verificationStatus: artifact.verificationStatus,
            },
          ]
        : [];
    });
  const artifactRefs = [
    ...durableArtifactRefs,
    ...(completionEnvelope ? completionArtifactRefs(completionEnvelope) : []),
  ];
  const evidenceSummary = completionEnvelope
    ? completionEvidenceSummary(completionEnvelope)
    : summaryText(data.evidence ?? data.diffSummary ?? data.testSummary);
  // A completion claim keeps its proof requirement even if an inconclusive
  // verifier subsequently moves the durable task to a user-waiting state.
  const evidenceRequired = eventStatus === "completed";
  const evidencePresent = Boolean(evidenceSummary || artifactRefs.length > 0);
  const verificationStatus = verificationFor(
    doc.task.status,
    doc.events,
    status,
  );
  const childTrajectoryIds = [
    ...new Set([
      ...(session?.childTrajectoryIds ?? []),
      ...stringArray(data.childTrajectoryIds),
      ...stringArray(data.trajectoryIds),
      ...(text(data.trajectoryId) ? [text(data.trajectoryId) as string] : []),
    ]),
  ];
  const sessionMeta = record(session?.metadata);
  const explicitDeliveryStatus = deliveryStatus(data.deliveryStatus);
  return {
    schemaVersion: 1,
    status,
    summary,
    evidence: {
      required: evidenceRequired,
      present: evidencePresent,
      sufficient:
        !evidenceRequired ||
        (evidencePresent && verificationStatus === "passed"),
      ...(evidenceSummary ? { summary: evidenceSummary } : {}),
      artifactRefs,
    },
    ...(blocker ? { blocker } : {}),
    ...(question ? { question } : {}),
    requiresUserInput: status === "awaiting_user",
    lineage: {
      taskId: doc.task.id,
      ...(sessionId ? { sessionId } : {}),
      ...(doc.task.parentTaskId ? { parentTaskId: doc.task.parentTaskId } : {}),
      ...(text(sessionMeta.parentSessionId)
        ? { parentSessionId: text(sessionMeta.parentSessionId) }
        : {}),
      ...(session?.traceId ? { traceId: session.traceId } : {}),
      ...(session?.parentTrajectoryStepId
        ? { parentTrajectoryStepId: session.parentTrajectoryStepId }
        : {}),
      childTrajectoryIds,
    },
    verificationStatus,
    deliveryStatus:
      explicitDeliveryStatus === "unknown" && session?.taskDelivered === true
        ? "delivered"
        : explicitDeliveryStatus,
  };
}
