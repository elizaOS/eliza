import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  parseToonKeyValue,
  type IAgentRuntime,
  ModelType,
} from "@elizaos/core";
import type {
  TaskNodeRecord,
  TaskRegistry,
  TaskThreadDetail,
  TaskVerifierJobRecord,
} from "./task-registry.js";
import { withTrajectoryContext } from "./trajectory-context.js";

type AcceptanceVerdict = "pass" | "fail";

interface AcceptanceChecklistItem {
  criterion: string;
  status: "pass" | "fail" | "partial";
  evidence: string;
}

interface AcceptanceEvaluation {
  verdict: AcceptanceVerdict;
  summary: string;
  checklist: AcceptanceChecklistItem[];
}

const terminalNodeStates = new Set([
  "completed",
  "failed",
  "canceled",
  "interrupted",
]);
const activeVerifierRuns = new Set<string>();

function normalizeChecklistItem(
  entry: unknown,
): AcceptanceChecklistItem | null {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const record = entry as Record<string, unknown>;
  const criterion =
    typeof record.criterion === "string" ? record.criterion.trim() : "";
  const rawStatus =
    typeof record.status === "string" ? record.status.trim() : "";
  const evidence =
    typeof record.evidence === "string" ? record.evidence.trim() : "";
  if (!criterion || !evidence) {
    return null;
  }
  return {
    criterion,
    status:
      rawStatus === "pass" || rawStatus === "fail" || rawStatus === "partial"
        ? rawStatus
        : "partial",
    evidence,
  };
}

function normalizeAcceptanceEvaluation(
  parsed: unknown,
): AcceptanceEvaluation | null {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    (record.verdict !== "pass" && record.verdict !== "fail") ||
    typeof record.summary !== "string" ||
    record.summary.trim().length === 0
  ) {
    return null;
  }
  const rawChecklist = record.checklist;
  const checklist = Array.isArray(rawChecklist)
    ? rawChecklist
        .map(normalizeChecklistItem)
        .filter((entry): entry is AcceptanceChecklistItem => Boolean(entry))
    : [];
  return {
    verdict: record.verdict,
    summary: record.summary.trim(),
    checklist,
  };
}

function parseAcceptanceEvaluation(raw: string): AcceptanceEvaluation | null {
  return normalizeAcceptanceEvaluation(
    parseToonKeyValue<Record<string, unknown>>(raw),
  );
}

function getVerifierRootDir(): string {
  const stateDir =
    process.env.ELIZA_STATE_DIR?.trim() || path.join(homedir(), ".eliza");
  return path.join(stateDir, "task-verifiers");
}

function truncate(text: string, limit = 1_200): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= limit ? compact : `${compact.slice(0, limit)}...`;
}

function isVerifierReady(
  thread: TaskThreadDetail,
  job: TaskVerifierJobRecord,
): boolean {
  if (job.status !== "pending") return false;
  if (job.verifierType !== "acceptance_criteria") return false;
  const executionNodes = thread.nodes.filter((node) => node.kind !== "goal");
  if (executionNodes.some((node) => !terminalNodeStates.has(node.status))) {
    return false;
  }
  if (!job.nodeId) return true;
  const node = thread.nodes.find((entry) => entry.id === job.nodeId);
  return node ? terminalNodeStates.has(node.status) : false;
}

function collectAcceptancePrerequisiteFailures(thread: TaskThreadDetail): {
  failedExecutionNodes: TaskNodeRecord[];
  completedWithoutEvidence: TaskNodeRecord[];
} {
  const executionNodes = thread.nodes.filter(
    (node) => node.kind === "execution",
  );
  const passedCompletionVerifierNodeIds = new Set(
    thread.verifierJobs
      .filter(
        (job) =>
          job.verifierType === "task_completion" &&
          job.status === "passed" &&
          typeof job.nodeId === "string",
      )
      .map((job) => job.nodeId as string),
  );
  const evidenceBackedNodeIds = new Set(
    thread.evidence
      .filter(
        (entry) =>
          typeof entry.nodeId === "string" &&
          (entry.evidenceType === "validation_summary" ||
            entry.evidenceType === "acceptance_report"),
      )
      .map((entry) => entry.nodeId as string),
  );
  return {
    failedExecutionNodes: executionNodes.filter(
      (node) =>
        node.status === "failed" ||
        node.status === "canceled" ||
        node.status === "interrupted",
    ),
    completedWithoutEvidence: executionNodes.filter(
      (node) =>
        node.status === "completed" &&
        !passedCompletionVerifierNodeIds.has(node.id) &&
        !evidenceBackedNodeIds.has(node.id),
    ),
  };
}

function buildDeterministicFailureEvaluation(
  thread: TaskThreadDetail,
  failures: ReturnType<typeof collectAcceptancePrerequisiteFailures>,
): AcceptanceEvaluation | null {
  if (failures.failedExecutionNodes.length > 0) {
    return {
      verdict: "fail",
      summary: `Acceptance cannot pass because execution nodes failed: ${failures.failedExecutionNodes.map((node) => node.title).join(", ")}.`,
      checklist: thread.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "fail",
        evidence: `Execution nodes failed before acceptance verification completed: ${failures.failedExecutionNodes.map((node) => `${node.title}=${node.status}`).join(", ")}.`,
      })),
    };
  }
  if (failures.completedWithoutEvidence.length > 0) {
    return {
      verdict: "fail",
      summary: `Acceptance cannot pass because completed execution nodes lack verification evidence: ${failures.completedWithoutEvidence.map((node) => node.title).join(", ")}.`,
      checklist: thread.acceptanceCriteria.map((criterion) => ({
        criterion,
        status: "partial",
        evidence: `Missing task-completion evidence for: ${failures.completedWithoutEvidence.map((node) => node.title).join(", ")}.`,
      })),
    };
  }
  return null;
}

function summarizeThreadEvidence(thread: TaskThreadDetail): string {
  const sessionSummaries = thread.sessions
    .map((session) =>
      [
        `${session.label} [${session.framework}] status=${session.status}`,
        session.completionSummary
          ? `summary=${truncate(session.completionSummary, 400)}`
          : "",
      ]
        .filter(Boolean)
        .join(" | "),
    )
    .filter(Boolean)
    .join("\n");
  const decisions = thread.decisions
    .slice(-8)
    .map(
      (decision) =>
        `${decision.decision}: ${truncate(decision.reasoning, 240)}`,
    )
    .join("\n");
  const artifacts = thread.artifacts
    .slice(-12)
    .map(
      (artifact) =>
        `${artifact.artifactType}: ${artifact.title}${artifact.path ? ` (${artifact.path})` : ""}`,
    )
    .join("\n");
  const evidence = thread.evidence
    .slice(-16)
    .map(
      (entry) =>
        `${entry.evidenceType}: ${entry.title}${entry.summary ? ` - ${truncate(entry.summary, 220)}` : ""}`,
    )
    .join("\n");
  const transcripts = thread.transcripts
    .slice(-8)
    .map((entry) => `${entry.direction}: ${truncate(entry.content, 240)}`)
    .join("\n");
  return [
    sessionSummaries ? `Sessions\n${sessionSummaries}` : "",
    decisions ? `Decisions\n${decisions}` : "",
    artifacts ? `Artifacts\n${artifacts}` : "",
    evidence ? `Evidence\n${evidence}` : "",
    transcripts ? `Recent transcripts\n${transcripts}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function evaluateAcceptanceCriteria(
  runtime: IAgentRuntime,
  thread: TaskThreadDetail,
  job: TaskVerifierJobRecord,
): Promise<AcceptanceEvaluation> {
  const prompt = [
    "You are a strict task verifier for an agent coordinator.",
    "Decide whether the thread satisfies its acceptance criteria based only on the provided evidence.",
    "Return TOON only with keys: verdict, summary, checklist.",
    'Set verdict to "pass" only if every criterion is satisfied by concrete evidence.',
    'Set verdict to "fail" if any criterion is missing, contradicted, or unsupported.',
    "Each checklist entry must contain criterion, status (pass|fail|partial), and evidence.",
    "Use this TOON shape:",
    "verdict: pass",
    "summary: One sentence explaining the decision.",
    "checklist[2]{criterion,status,evidence}:",
    "  Acceptance criterion one,pass,Concrete evidence for criterion one",
    "  Acceptance criterion two,fail,What evidence is missing or contradictory",
    "",
    `Thread title: ${thread.title}`,
    `Original request: ${thread.originalRequest}`,
    `Verifier job: ${job.title}`,
    `Acceptance criteria:\n${thread.acceptanceCriteria.map((criterion, index) => `${index + 1}. ${criterion}`).join("\n")}`,
    "",
    `Thread evidence:\n${summarizeThreadEvidence(thread) || "No evidence recorded."}`,
  ].join("\n");

  const raw = await withTrajectoryContext(
    runtime,
    {
      source: "orchestrator",
      decisionType: "acceptance-verifier",
      threadId: thread.id,
      verifierJobId: job.id,
    },
    () =>
      runtime.useModel(ModelType.TEXT_SMALL, {
        prompt,
        temperature: 0,
        stream: false,
      }),
  );
  const parsed = parseAcceptanceEvaluation(raw);
  if (parsed) {
    return parsed;
  }
  return {
    verdict: "fail",
    summary:
      "Acceptance verifier returned an invalid response, so the thread could not be proven complete.",
    checklist: thread.acceptanceCriteria.map((criterion) => ({
      criterion,
      status: "partial",
      evidence: "Verifier response was invalid TOON.",
    })),
  };
}

async function writeAcceptanceReport(
  thread: TaskThreadDetail,
  job: TaskVerifierJobRecord,
  evaluation: AcceptanceEvaluation,
): Promise<{ reportPath: string; sha256: string }> {
  const dir = path.join(getVerifierRootDir(), thread.id);
  await mkdir(dir, { recursive: true });
  const reportPath = path.join(dir, `${job.id}.json`);
  const report = {
    threadId: thread.id,
    verifierJobId: job.id,
    title: job.title,
    originalRequest: thread.originalRequest,
    acceptanceCriteria: thread.acceptanceCriteria,
    evaluation,
    generatedAt: new Date().toISOString(),
  };
  const serialized = JSON.stringify(report, null, 2);
  await writeFile(reportPath, serialized, "utf8");
  return {
    reportPath,
    sha256: createHash("sha256").update(serialized).digest("hex"),
  };
}

async function finalizeAcceptanceJob(
  taskRegistry: TaskRegistry,
  thread: TaskThreadDetail,
  job: TaskVerifierJobRecord,
  evaluation: AcceptanceEvaluation,
  reportPath: string,
  sha256: string,
): Promise<void> {
  await taskRegistry.updateTaskVerifierJob(job.id, {
    status: evaluation.verdict === "pass" ? "passed" : "failed",
    completedAt: new Date().toISOString(),
    metadata: {
      verdict: evaluation.verdict,
      summary: evaluation.summary,
      reportPath,
      sha256,
      checklist: evaluation.checklist,
    },
  });
  await taskRegistry.recordArtifact({
    threadId: thread.id,
    sessionId: thread.latestSessionId ?? null,
    artifactType: "acceptance_report",
    title: `${job.title} report`,
    path: reportPath,
    mimeType: "application/json",
    metadata: {
      verifierJobId: job.id,
      verdict: evaluation.verdict,
      sha256,
    },
  });
  await taskRegistry.recordTaskEvidence({
    threadId: thread.id,
    nodeId: job.nodeId,
    sessionId: thread.latestSessionId ?? null,
    verifierJobId: job.id,
    evidenceType: "acceptance_report",
    title: job.title,
    summary: evaluation.summary,
    path: reportPath,
    content: {
      checklist: evaluation.checklist,
      verdict: evaluation.verdict,
    },
    metadata: {
      sha256,
    },
  });
  await taskRegistry.appendEvent({
    threadId: thread.id,
    sessionId: thread.latestSessionId ?? null,
    eventType: "verifier_job_completed",
    summary: `${job.title} ${evaluation.verdict}`,
    data: {
      verifierJobId: job.id,
      verdict: evaluation.verdict,
      reportPath,
    },
  });
  if (job.nodeId) {
    const node = thread.nodes.find((entry) => entry.id === job.nodeId);
    const patch =
      evaluation.verdict === "pass"
        ? {
            metadata: {
              acceptanceVerifierJobId: job.id,
              acceptanceSummary: evaluation.summary,
            },
          }
        : {
            status: "failed" as const,
            metadata: {
              acceptanceVerifierJobId: job.id,
              acceptanceSummary: evaluation.summary,
            },
          };
    if (node) {
      await taskRegistry.updateTaskNode(node.id, patch);
    }
  }
}

export async function runReadyTaskVerifiers(
  runtime: IAgentRuntime,
  taskRegistry: TaskRegistry,
  threadId: string,
): Promise<void> {
  let thread = await taskRegistry.getThread(threadId);
  if (!thread) {
    return;
  }
  const readyJobs = thread.verifierJobs.filter((job) =>
    isVerifierReady(thread as TaskThreadDetail, job),
  );
  for (const job of readyJobs) {
    if (activeVerifierRuns.has(job.id)) {
      continue;
    }
    activeVerifierRuns.add(job.id);
    try {
      await taskRegistry.updateTaskVerifierJob(job.id, {
        status: "running",
        startedAt: new Date().toISOString(),
        metadata: {
          source: "acceptance-runner",
        },
      });
      await taskRegistry.appendEvent({
        threadId,
        sessionId: thread.latestSessionId ?? null,
        eventType: "verifier_job_started",
        summary: `Running ${job.title}`,
        data: {
          verifierJobId: job.id,
          verifierType: job.verifierType,
        },
      });
      thread = (await taskRegistry.getThread(threadId)) ?? thread;
      const deterministicFailure = buildDeterministicFailureEvaluation(
        thread,
        collectAcceptancePrerequisiteFailures(thread),
      );
      const evaluation =
        deterministicFailure ??
        (await evaluateAcceptanceCriteria(runtime, thread, job));
      const report = await writeAcceptanceReport(thread, job, evaluation);
      await finalizeAcceptanceJob(
        taskRegistry,
        thread,
        job,
        evaluation,
        report.reportPath,
        report.sha256,
      );
      thread = (await taskRegistry.getThread(threadId)) ?? thread;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await taskRegistry.updateTaskVerifierJob(job.id, {
        status: "failed",
        completedAt: new Date().toISOString(),
        metadata: {
          source: "acceptance-runner",
          error: message,
        },
      });
      await taskRegistry.appendEvent({
        threadId,
        sessionId: thread.latestSessionId ?? null,
        eventType: "verifier_job_failed",
        summary: `${job.title} failed`,
        data: {
          verifierJobId: job.id,
          error: message,
        },
      });
      if (job.nodeId) {
        await taskRegistry.updateTaskNode(job.nodeId, {
          status: "failed",
          metadata: {
            acceptanceVerifierJobId: job.id,
            acceptanceSummary: message,
          },
        });
      }
    } finally {
      activeVerifierRuns.delete(job.id);
    }
  }
}

export function isTerminalTaskNodeStatus(
  status: TaskNodeRecord["status"],
): boolean {
  return terminalNodeStates.has(status);
}
