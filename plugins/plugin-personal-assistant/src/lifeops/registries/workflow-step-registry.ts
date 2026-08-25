/**
 * WorkflowStepRegistry — open registry of executable workflow step kinds.
 *
 * Open registry of executable workflow step kinds. Plugins and tests can
 * register a new step kind at runtime by contributing a
 * `WorkflowStepContribution`; the dispatcher consults this registry.
 *
 * Follows the same per-runtime `WeakMap` binding pattern as
 * `AnchorRegistry` / `EventKindRegistry` / `FamilyRegistry`.
 */

import type { IAgentRuntime } from "@elizaos/core";
import type {
  CreateLifeOpsBrowserSessionRequest,
  CreateLifeOpsDefinitionRequest,
  GetLifeOpsCalendarFeedRequest,
  GetLifeOpsGmailTriageRequest,
  GetLifeOpsGmailUnrespondedRequest,
  GetLifeOpsHealthSummaryRequest,
  LifeOpsBrowserSession,
  LifeOpsCalendarFeed,
  LifeOpsDefinitionRecord,
  LifeOpsGmailTriageFeed,
  LifeOpsGmailUnrespondedFeed,
  LifeOpsHealthSummaryResponse,
  LifeOpsWorkflowDefinition,
} from "@elizaos/shared";
import type { z } from "zod";

/**
 * Strongly-typed surface of `LifeOpsServiceBase` (composed mixins) that the
 * default workflow-step contributions consume. Defining the shape here lets
 * each contribution's `execute` callback take a typed `ctx` parameter
 * instead of an opaque `any`. Third-party contributions can rely on the
 * documented surface; nothing inside the dispatcher leaks.
 */
export interface WorkflowStepExecuteContext {
  readonly runtime: IAgentRuntime;
  readonly repository: {
    updateBrowserSession(session: LifeOpsBrowserSession): Promise<void>;
  };

  createDefinition(
    request: CreateLifeOpsDefinitionRequest,
  ): Promise<LifeOpsDefinitionRecord>;

  relockWebsiteAccessGroup(groupKey: string, now?: Date): Promise<{ ok: true }>;

  resolveWebsiteAccessCallback(
    callbackKey: string,
    now?: Date,
  ): Promise<{ ok: true }>;

  getCalendarFeed(
    requestUrl: URL,
    request?: GetLifeOpsCalendarFeedRequest,
    now?: Date,
  ): Promise<LifeOpsCalendarFeed>;

  getGmailTriage(
    requestUrl: URL,
    request?: GetLifeOpsGmailTriageRequest,
    now?: Date,
  ): Promise<LifeOpsGmailTriageFeed>;

  getGmailUnresponded(
    requestUrl: URL,
    request?: GetLifeOpsGmailUnrespondedRequest,
    now?: Date,
  ): Promise<LifeOpsGmailUnrespondedFeed>;

  getHealthSummary(
    request?: GetLifeOpsHealthSummaryRequest,
  ): Promise<LifeOpsHealthSummaryResponse>;

  createBrowserSessionInternal(
    request: CreateLifeOpsBrowserSessionRequest,
  ): Promise<LifeOpsBrowserSession>;

  recordBrowserAudit(
    eventType: "browser_session_created" | "browser_session_updated",
    ownerId: string,
    reason: string,
    inputs: Record<string, unknown>,
    decision: Record<string, unknown>,
  ): Promise<void>;
}

/**
 * Per-step execution arguments passed alongside the step itself. Carries the
 * workflow's owning definition (for permission policy / ownership defaults),
 * the run timestamp, the accumulated `outputs` map, and the latest step's
 * recorded value (used by `summarize`).
 */
export interface WorkflowStepExecuteArgs {
  readonly definition: LifeOpsWorkflowDefinition;
  readonly startedAt: string;
  readonly confirmBrowserActions: boolean;
  /** Trigger ancestry inherited by native workflows dispatched from this run. */
  readonly triggerChainDepth: number;
  readonly request: Record<string, unknown>;
  readonly outputs: Record<string, unknown>;
  readonly previousStepValue: unknown;
}

/**
 * Arguments handed to a contribution's `compensate` callback when a later
 * step in the same run failed. `executedValue` is the value this step's
 * `execute` returned, so compensation can target the exact side effect
 * (e.g. the created task id or browser session id).
 */
export interface WorkflowStepCompensateArgs {
  readonly definition: LifeOpsWorkflowDefinition;
  readonly startedAt: string;
  readonly request: Record<string, unknown>;
  readonly executedValue: unknown;
}

export interface WorkflowStepContribution<
  TStep extends { kind: string } = { kind: string },
  TResult = unknown,
> {
  /** Stable identifier — must match `step.kind` at dispatch time. */
  readonly kind: string;
  readonly describe: { label: string; description: string; provider: string };
  /**
   * Zod schema validated against the raw step record before execution. The
   * schema is the source of truth for the contribution's parameter shape;
   * its inferred type drives `execute`'s `step` parameter.
   */
  readonly paramSchema: z.ZodType<TStep>;
  /**
   * Execute the step. Receives the validated step + per-run args + the
   * typed service context.
   */
  execute(
    step: TStep,
    args: WorkflowStepExecuteArgs,
    ctx: WorkflowStepExecuteContext,
  ): Promise<TResult>;
  /**
   * Optional failure compensation. When a later step in the run throws, the
   * dispatcher invokes `compensate` on every already-executed step that
   * declares one, in reverse execution order. Compensation must be
   * best-effort idempotent: it may run again if a replayed run fails at the
   * same point. Read-only steps should omit it.
   */
  compensate?(
    step: TStep,
    args: WorkflowStepCompensateArgs,
    ctx: WorkflowStepExecuteContext,
  ): Promise<void>;
}

export type AnyWorkflowStepContribution = WorkflowStepContribution<
  { kind: string },
  unknown
>;

/**
 * Thrown when the dispatcher encounters a `step.kind` with no registered
 * contribution. Carries the offending kind + the current registered set so
 * planners can surface a precise diagnostic.
 */
export class UnknownWorkflowStepError extends Error {
  public readonly kind: string;
  public readonly knownKinds: readonly string[];

  constructor(kind: string, knownKinds: readonly string[]) {
    super(
      `Unknown workflow step kind "${kind}". Registered kinds: ${
        knownKinds.length === 0 ? "(none)" : knownKinds.join(", ")
      }`,
    );
    this.name = "UnknownWorkflowStepError";
    this.kind = kind;
    this.knownKinds = knownKinds;
  }
}

export interface WorkflowStepRegistry {
  register(contribution: AnyWorkflowStepContribution): void;
  has(kind: string): boolean;
  get(kind: string): AnyWorkflowStepContribution | null;
  list(): AnyWorkflowStepContribution[];
}

class InMemoryWorkflowStepRegistry implements WorkflowStepRegistry {
  private readonly byKind = new Map<string, AnyWorkflowStepContribution>();

  register(contribution: AnyWorkflowStepContribution): void {
    if (!contribution.kind) {
      throw new Error("WorkflowStepRegistry.register: kind is required");
    }
    if (this.byKind.has(contribution.kind)) {
      throw new Error(
        `WorkflowStepRegistry.register: kind "${contribution.kind}" already registered`,
      );
    }
    this.byKind.set(contribution.kind, contribution);
  }

  has(kind: string): boolean {
    return this.byKind.has(kind);
  }

  get(kind: string): AnyWorkflowStepContribution | null {
    return this.byKind.get(kind) ?? null;
  }

  list(): AnyWorkflowStepContribution[] {
    return Array.from(this.byKind.values());
  }
}

export function createWorkflowStepRegistry(): WorkflowStepRegistry {
  return new InMemoryWorkflowStepRegistry();
}

// ---------------------------------------------------------------------------
// Per-runtime registration. Mirrors AnchorRegistry / EventKindRegistry /
// FamilyRegistry — `WeakMap` keyed by runtime so the lifetime tracks the
// runtime and we don't leak across tests.
// ---------------------------------------------------------------------------

const registries = new WeakMap<IAgentRuntime, WorkflowStepRegistry>();

export function registerWorkflowStepRegistry(
  runtime: IAgentRuntime,
  registry: WorkflowStepRegistry,
): void {
  registries.set(runtime, registry);
}

export function getWorkflowStepRegistry(
  runtime: IAgentRuntime,
): WorkflowStepRegistry | null {
  return registries.get(runtime) ?? null;
}

export function __resetWorkflowStepRegistryForTests(
  runtime: IAgentRuntime,
): void {
  registries.delete(runtime);
}
