/**
 * Class-level standing guarantees over obligation artifacts (#14864). One
 * owner utterance ("always track contract renewals") installs a single
 * event-triggered ScheduledTask; from then on every newly observed
 * deadline-bearing artifact of that class deterministically gains its ledger
 * row + deadline watcher through the document hooks, plus a lead-time warn
 * watcher (contract renewal → 60-day warn by default) installed here. All
 * matching branches on typed fields (`trigger.eventKind`, filter
 * `obligationKind`, `metadata.standingGuarantee`), never on prompt prose.
 */
import type { EventPayload, IAgentRuntime } from "@elizaos/core";
import type { ScheduledTask } from "../scheduled-task/index.js";
import { getScheduledTaskRunner } from "../scheduled-task/service.js";
import {
  COMMITMENT_OBLIGATION_EVENT_KIND,
  type LifeOpsCommitmentKind,
} from "./ledger.js";

export interface CommitmentClassGuaranteeInput {
  agentId: string;
  obligationClass: LifeOpsCommitmentKind;
  /** Days before the artifact deadline the warn watcher fires. */
  warnDaysBefore?: number;
}

export interface ObservedObligationArtifact {
  documentId: string;
  title: string;
  /** ISO-8601 artifact deadline. */
  deadline: string;
  obligationKind: LifeOpsCommitmentKind;
}

/**
 * Payload of `COMMITMENT_OBLIGATION_EVENT_KIND`. The scheduling event bridge
 * subset-matches guarantee filters (`obligationKind`) against these fields.
 */
export interface CommitmentObligationEventPayload extends EventPayload {
  obligationKind: LifeOpsCommitmentKind;
  documentId: string;
  title: string;
  deadline: string;
}

export interface ApplyGuaranteesResult {
  matchedGuaranteeTaskIds: string[];
  warnTaskIds: string[];
}

const DEFAULT_WARN_DAYS_BEFORE = 60;
const DAY_MS = 24 * 60 * 60 * 1000;

const OBLIGATION_KINDS: readonly LifeOpsCommitmentKind[] = [
  "commitment",
  "renewal",
  "filing",
  "warranty",
];

export function normalizeObligationClass(
  value: unknown,
): LifeOpsCommitmentKind | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (OBLIGATION_KINDS as readonly string[]).includes(lower)
    ? (lower as LifeOpsCommitmentKind)
    : null;
}

function guaranteeIdempotencyKey(obligationClass: LifeOpsCommitmentKind) {
  return `commitment-guarantee:${obligationClass}`;
}

function guaranteeWarnDays(task: ScheduledTask): number {
  const raw = (task.metadata as Record<string, unknown> | undefined)
    ?.warnDaysBefore;
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0
    ? raw
    : DEFAULT_WARN_DAYS_BEFORE;
}

function isGuaranteeForClass(
  task: ScheduledTask,
  obligationKind: LifeOpsCommitmentKind,
): boolean {
  if (task.trigger.kind !== "event") return false;
  if (task.trigger.eventKind !== COMMITMENT_OBLIGATION_EVENT_KIND) return false;
  const metadata = (task.metadata ?? {}) as Record<string, unknown>;
  if (metadata.standingGuarantee !== true) return false;
  const filter = task.trigger.filter;
  const filterKind =
    filter && typeof filter === "object"
      ? (filter as Record<string, unknown>).obligationKind
      : undefined;
  return filterKind === obligationKind;
}

/**
 * Install (or idempotently reuse) the standing guarantee for one obligation
 * class. The task is event-triggered: the bridge fires it whenever
 * `COMMITMENT_OBLIGATION_EVENT_KIND` is emitted with a matching
 * `obligationKind`, producing the owner-visible "now tracking" notice. The
 * structural row/watcher work happens in `applyCommitmentClassGuarantees`.
 */
export async function installCommitmentClassGuarantee(
  runtime: IAgentRuntime,
  input: CommitmentClassGuaranteeInput,
): Promise<ScheduledTask> {
  const warnDaysBefore = input.warnDaysBefore ?? DEFAULT_WARN_DAYS_BEFORE;
  const runner = getScheduledTaskRunner(runtime, { agentId: input.agentId });
  return runner.schedule({
    kind: "watcher",
    promptInstructions: `A new ${input.obligationClass} obligation was observed and is now tracked. Tell the owner what it is and when its deadline and ${warnDaysBefore}-day warning fall. Never expose internal record identifiers.`,
    trigger: {
      kind: "event",
      eventKind: COMMITMENT_OBLIGATION_EVENT_KIND,
      filter: { obligationKind: input.obligationClass },
    },
    priority: "medium",
    idempotencyKey: guaranteeIdempotencyKey(input.obligationClass),
    respectsGlobalPause: true,
    source: "user_chat",
    createdBy: input.agentId,
    ownerVisible: true,
    metadata: {
      standingGuarantee: true,
      obligationClass: input.obligationClass,
      warnDaysBefore,
    },
  });
}

/** List the installed standing guarantees matching one obligation class. */
export async function listCommitmentClassGuarantees(
  runtime: IAgentRuntime,
  args: { agentId: string; obligationKind: LifeOpsCommitmentKind },
): Promise<ScheduledTask[]> {
  const runner = getScheduledTaskRunner(runtime, { agentId: args.agentId });
  const tasks = await runner.list({ kind: "watcher", status: "scheduled" });
  return tasks.filter((task) => isGuaranteeForClass(task, args.obligationKind));
}

/**
 * Structural consequence of a newly observed deadline-bearing artifact: when
 * a standing guarantee covers its class, schedule the lead-time warn watcher
 * and emit the obligation event so the guarantee task itself fires through
 * the spine's event bridge. Idempotent per artifact + deadline + lead time —
 * replayed observations reuse the same warn watcher. Callers own the base
 * ledger row + deadline watcher (document hooks already create those).
 */
export async function applyCommitmentClassGuarantees(
  runtime: IAgentRuntime,
  args: { agentId: string; artifact: ObservedObligationArtifact },
): Promise<ApplyGuaranteesResult> {
  const { artifact } = args;
  const guarantees = await listCommitmentClassGuarantees(runtime, {
    agentId: args.agentId,
    obligationKind: artifact.obligationKind,
  });
  if (guarantees.length === 0) {
    return { matchedGuaranteeTaskIds: [], warnTaskIds: [] };
  }

  const runner = getScheduledTaskRunner(runtime, { agentId: args.agentId });
  const deadlineMs = Date.parse(artifact.deadline);
  if (Number.isNaN(deadlineMs)) {
    throw new Error(
      `applyCommitmentClassGuarantees: artifact ${artifact.documentId} has an unparseable deadline "${artifact.deadline}".`,
    );
  }

  const warnTaskIds: string[] = [];
  for (const guarantee of guarantees) {
    const warnDays = guaranteeWarnDays(guarantee);
    const warnAtMs = deadlineMs - warnDays * DAY_MS;
    if (warnAtMs <= Date.now()) continue;
    const warnAtIso = new Date(warnAtMs).toISOString();
    const warnTask = await runner.schedule({
      kind: "watcher",
      promptInstructions: `The ${artifact.obligationKind} deadline for "${artifact.title}" is ${warnDays} days away (${artifact.deadline}). Warn the owner and ask whether to renew, renegotiate, or let it lapse. Never expose internal record identifiers.`,
      trigger: { kind: "once", atIso: warnAtIso },
      priority: "medium",
      subject: { kind: "document", id: artifact.documentId },
      idempotencyKey: `commitment-warn:${artifact.documentId}:${artifact.deadline}:${warnDays}`,
      respectsGlobalPause: true,
      source: "plugin",
      createdBy: args.agentId,
      ownerVisible: true,
      metadata: {
        standingGuaranteeTaskId: guarantee.taskId,
        obligationKind: artifact.obligationKind,
        documentId: artifact.documentId,
        documentTitle: artifact.title,
        warnDaysBefore: warnDays,
      },
    });
    warnTaskIds.push(warnTask.taskId);
  }

  const obligationPayload: CommitmentObligationEventPayload = {
    runtime,
    source: "plugin-personal-assistant:commitments",
    obligationKind: artifact.obligationKind,
    documentId: artifact.documentId,
    title: artifact.title,
    deadline: artifact.deadline,
  };
  await runtime.emitEvent(COMMITMENT_OBLIGATION_EVENT_KIND, obligationPayload);

  return {
    matchedGuaranteeTaskIds: guarantees.map((task) => task.taskId),
    warnTaskIds,
  };
}
