/** Host-composed task adapter. Product policy and evidence storage stay with the host. */
import { ElizaError } from "@elizaos/core/errors";
import {
  type InteractiveTask,
  sameTaskOwner,
  type TaskActionProposal,
  type TaskObservation,
  type TaskOwner,
} from "@elizaos/core/messaging/interactive-task";
import type {
  NativeSocketBrowserTarget,
  NativeTaskBinding,
  NativeTaskContext,
} from "./native-socket-target.js";

export interface TaskBrowserSnapshot {
  snapshotId: string;
  documentId: string;
  url: string;
  inputRevision: number;
  elements: Array<{ selector: string; [key: string]: unknown }>;
  [key: string]: unknown;
}
export interface TaskBrowserPolicy {
  tabId: string;
  origin: string;
  leaseMs: number;
  targets: NativeTaskBinding["targets"];
}
function fail(message: string): never {
  throw new ElizaError(message, { code: "TASK_ACTION_DENIED" });
}

export class NativeTaskActuator {
  readonly capabilities = [
    "browser.click",
    "browser.fill",
    "browser.scroll.up",
    "browser.scroll.down",
    "browser.scroll.left",
    "browser.scroll.right",
  ] as const;
  private bindings = new Map<
    string,
    { context: NativeTaskContext; policy: TaskBrowserPolicy; expiresAt: number }
  >();
  private guidanceRevisions = new Map<string, number>();
  private activeGuidance = new Set<string>();
  private observations = new Map<
    string,
    {
      observation: TaskObservation;
      snapshot: TaskBrowserSnapshot;
      epoch: number;
    }
  >();
  constructor(
    private options: {
      target: Pick<NativeSocketBrowserTarget, "bindTask" | "execute"> &
        Partial<Pick<NativeSocketBrowserTarget, "guideTask">>;
      getTask: (id: string) => InteractiveTask;
      policy: (task: InteractiveTask) => TaskBrowserPolicy;
      /** Durable and strictly increasing per tab, including after host restart. */
      nextBindingRevision: (tabId: string) => number;
      resolveValue: (
        reference: string,
        task: InteractiveTask,
      ) => Promise<string | { kind: "verification-code"; text: string }>;
      /** Must establish the expected effect from observed page facts, not a dispatch receipt. */
      verify: (
        proposal: TaskActionProposal,
        before: TaskBrowserSnapshot,
        after: TaskBrowserSnapshot,
      ) => Promise<"succeeded" | "failed" | "unknown">;
      /** Persist only appropriately redacted evidence; returns an opaque durable reference. */
      recordEvidence: (
        task: InteractiveTask,
        proposal: TaskActionProposal,
        before: TaskBrowserSnapshot,
        after: TaskBrowserSnapshot,
        result: "succeeded" | "failed" | "unknown",
      ) => Promise<string>;
      now?: () => number;
    },
  ) {}
  private now() {
    return this.options.now?.() ?? Date.now();
  }
  private task(id: string, owner: TaskOwner) {
    const task = this.options.getTask(id);
    if (
      !sameTaskOwner(task.owner, owner) ||
      task.authorization.state !== "active" ||
      ["completed", "cancelled", "blocked"].includes(task.status)
    )
      fail("Task authority ended");
    return task;
  }
  private async bind(task: InteractiveTask) {
    const cached = this.bindings.get(task.id);
    if (cached && cached.context.epoch === task.epoch) {
      if (cached.expiresAt <= this.now())
        fail("Resume with a fresh task epoch after the browser lease expires");
      return cached;
    }
    const policy = structuredClone(this.options.policy(task));
    if (
      !task.allowedOrigins.includes(policy.origin) ||
      !Number.isSafeInteger(policy.leaseMs) ||
      policy.leaseMs < 1 ||
      policy.leaseMs > 300000
    )
      fail("Invalid task browser policy");
    const context = {
      actorId: task.owner.actorId,
      accountId: task.owner.connector.accountId,
      agentId: task.owner.agentId,
      taskId: task.id,
      epoch: task.epoch,
    };
    const binding = {
      ...context,
      tabId: policy.tabId,
      bindingRevision: this.options.nextBindingRevision(policy.tabId),
      origin: policy.origin,
      expiresAt: this.now() + policy.leaseMs,
      targets: policy.targets,
      revoked: false,
    };
    const reply = (await this.options.target.bindTask(binding)) as Record<
      string,
      unknown
    >;
    if (
      reply?.bound !== true ||
      reply.tabId !== policy.tabId ||
      reply.taskId !== task.id ||
      reply.epoch !== task.epoch ||
      reply.bindingRevision !== binding.bindingRevision
    )
      fail("Browser did not acknowledge the task binding");
    const entry = { context, policy, expiresAt: binding.expiresAt };
    this.bindings.set(task.id, entry);
    return entry;
  }
  private async snapshot(
    binding: Awaited<ReturnType<NativeTaskActuator["bind"]>>,
    signal: AbortSignal,
  ) {
    signal.throwIfAborted();
    const reply = await this.options.target.execute(
      { subaction: "snapshot", id: binding.policy.tabId },
      { taskContext: binding.context, signal },
    );
    const result = (
      reply.value as { result?: { snapshotId?: unknown; frames?: unknown[] } }
    )?.result;
    const frame = result?.frames?.[0] as Record<string, unknown> | undefined;
    if (
      typeof result?.snapshotId !== "string" ||
      result.frames?.length !== 1 ||
      !frame ||
      frame.frameId !== 0 ||
      frame.complete !== true ||
      typeof frame.documentId !== "string" ||
      typeof frame.url !== "string" ||
      new URL(frame.url).origin !== binding.policy.origin ||
      !Number.isSafeInteger(frame.inputRevision) ||
      Number(frame.inputRevision) < 0 ||
      !Array.isArray(frame.elements)
    )
      fail("Incomplete or wrong-context browser observation");
    const snapshot = {
      ...frame,
      snapshotId: result?.snapshotId,
    } as TaskBrowserSnapshot;
    if (
      snapshot.elements.some(
        (item) =>
          !item ||
          typeof item.selector !== "string" ||
          !item.selector.startsWith(`${snapshot.snapshotId}:0:`),
      )
    )
      fail("Invalid browser target references");
    return snapshot;
  }
  async observe(context: {
    owner: TaskOwner;
    taskId: string;
    signal: AbortSignal;
  }): Promise<TaskObservation> {
    const task = this.task(context.taskId, context.owner);
    const binding = await this.bind(task);
    const snapshot = await this.snapshot(binding, context.signal);
    const current = this.task(task.id, context.owner);
    if (current.epoch !== task.epoch || current.revision !== task.revision)
      fail("Task changed during observation");
    const observation = {
      id: snapshot.snapshotId,
      pageId: snapshot.documentId,
      origin: binding.policy.origin,
      version: (task.observation?.version ?? 0) + 1,
      inputRevision: snapshot.inputRevision,
      observedAt: this.now(),
    };
    this.observations.set(task.id, {
      observation,
      snapshot,
      epoch: task.epoch,
    });
    return observation;
  }
  /** Trusted planner/guide read; this is page data, never authorization. */
  readObservation(taskId: string, owner: TaskOwner) {
    const task = this.task(taskId, owner);
    const cached = this.observations.get(taskId);
    if (
      !cached ||
      cached.epoch !== task.epoch ||
      task.observation?.id !== cached.observation.id
    )
      fail("No current browser observation");
    return structuredClone({
      observation: cached.observation,
      snapshot: cached.snapshot,
    });
  }

  /** Host-owned guidance text/target; no renderer-supplied DOM or authorization. */
  async showGuidance(
    taskId: string,
    owner: TaskOwner,
    input: {
      stepId: string;
      targetRef: string;
      text: string;
      restore?: boolean;
    },
    signal: AbortSignal,
  ): Promise<void> {
    const task = this.task(taskId, owner);
    const { snapshot } = this.readObservation(taskId, owner);
    const binding = this.bindings.get(taskId);
    const guide = this.options.target.guideTask;
    if (
      task.status !== "active" ||
      !binding ||
      !guide ||
      !snapshot.elements.some((element) => element.selector === input.targetRef)
    )
      fail("Guidance requires an active observed task target");
    signal.throwIfAborted();
    const revision = (this.guidanceRevisions.get(taskId) ?? 0) + 1;
    this.guidanceRevisions.set(taskId, revision);
    this.activeGuidance.add(taskId);
    try {
      const reply = (await guide.call(
        this.options.target,
        {
          kind: "show",
          tabId: binding.policy.tabId,
          taskContext: binding.context,
          revision,
          stepId: input.stepId,
          selector: input.targetRef,
          text: input.text,
          restore: input.restore,
          expiresAt: Math.min(binding.expiresAt, this.now() + 60000),
        },
        signal,
      )) as { accepted?: boolean };
      const current = this.task(taskId, owner);
      if (
        reply?.accepted !== true ||
        signal.aborted ||
        current.status !== "active" ||
        current.epoch !== task.epoch ||
        current.observation?.id !== task.observation?.id ||
        this.guidanceRevisions.get(taskId) !== revision
      )
        fail("Guidance context changed before acknowledgement");
    } catch (error) {
      if (this.guidanceRevisions.get(taskId) === revision)
        await this.quiesce({ owner, taskId });
      throw error;
    }
  }

  /** May run after task revocation. It only removes this owner's cached overlay. */
  async quiesce({
    owner,
    taskId,
  }: {
    owner: TaskOwner;
    taskId: string;
  }): Promise<void> {
    if (!this.activeGuidance.has(taskId)) return;
    const binding = this.bindings.get(taskId),
      guide = this.options.target.guideTask;
    if (
      !binding ||
      !guide ||
      binding.context.actorId !== owner.actorId ||
      binding.context.accountId !== owner.connector.accountId ||
      binding.context.agentId !== owner.agentId
    )
      fail("Guidance cleanup owner is invalid");
    const revision = (this.guidanceRevisions.get(taskId) ?? 0) + 1;
    this.guidanceRevisions.set(taskId, revision);
    const reply = (await guide.call(this.options.target, {
      kind: "hide",
      tabId: binding.policy.tabId,
      taskContext: binding.context,
      revision,
    })) as { visible?: boolean };
    if (
      reply?.visible !== false ||
      this.guidanceRevisions.get(taskId) !== revision
    )
      fail("Guidance removal was not acknowledged");
    this.activeGuidance.delete(taskId);
  }

  async execute(
    proposal: TaskActionProposal,
    context: {
      owner: TaskOwner;
      signal: AbortSignal;
      isCurrent: () => boolean;
    },
  ): Promise<
    | { status: "succeeded" | "failed"; evidenceRef: string }
    | { status: "unknown"; evidenceRef?: string }
  > {
    const task = this.task(proposal.taskId, context.owner);
    const cached = this.observations.get(task.id);
    const binding = this.bindings.get(task.id);
    const current = () =>
      !context.signal.aborted &&
      context.isCurrent() &&
      this.task(task.id, context.owner).epoch === proposal.epoch;
    if (
      task.status !== "waiting" ||
      task.authorization.decisionId !== proposal.authorizationId ||
      task.observation?.id !== proposal.observationId ||
      !task.operations.some(
        (operation) =>
          operation.status === "dispatched" &&
          operation.proposal.id === proposal.id,
      ) ||
      !current() ||
      !binding ||
      binding.expiresAt <= this.now() ||
      !cached ||
      cached.epoch !== proposal.epoch ||
      cached.observation.id !== proposal.observationId ||
      cached.observation.version !== proposal.observationVersion ||
      cached.observation.inputRevision !== proposal.inputRevision ||
      !cached.snapshot.elements.some(
        (item) => item.selector === proposal.targetRef,
      )
    )
      fail("Action has no current browser observation");
    if (
      !task.allowedCapabilities.includes(proposal.capability) ||
      !this.capabilities.includes(
        proposal.capability as (typeof this.capabilities)[number],
      )
    )
      fail("Browser action is not authorized");
    const direction = proposal.capability.split(".")[2] as
      | "up"
      | "down"
      | "left"
      | "right"
      | undefined;
    const subaction = proposal.capability.split(".")[1] as
      | "click"
      | "fill"
      | "scroll";
    const resolved =
      subaction === "fill"
        ? await this.options.resolveValue(
            proposal.valueRef ||
              fail("Fill requires a protected value reference"),
            task,
          )
        : undefined;
    if (
      resolved !== undefined &&
      typeof resolved !== "string" &&
      (resolved?.kind !== "verification-code" ||
        typeof resolved.text !== "string" ||
        !/^[A-Za-z0-9]{4,12}$/.test(resolved.text))
    )
      fail("Invalid protected value");
    const protectedValueKind =
      typeof resolved === "object" ? resolved.kind : undefined;
    const text = typeof resolved === "object" ? resolved.text : resolved;
    if (
      !current() ||
      this.now() >= proposal.expiresAt ||
      binding.expiresAt <= this.now()
    )
      fail("Action expired before dispatch");
    if (!this.options.target.guideTask) fail("Action feedback is unavailable");
    // Negotiate acknowledged cleanup before dispatch. The native command owns
    // its pointer, while this marker lets Pause await removal even in flight.
    this.activeGuidance.add(task.id);
    await this.quiesce({ owner: context.owner, taskId: task.id });
    if (!current()) fail("Action cancelled before feedback");
    this.observations.delete(task.id); // Never reuse a consumed target after any dispatch attempt.
    this.activeGuidance.add(task.id);
    try {
      await this.options.target.execute(
        {
          subaction,
          id: binding.policy.tabId,
          selector: proposal.targetRef,
          ...(text === undefined ? {} : { text }),
          ...(subaction === "scroll" ? { direction } : {}),
        },
        {
          taskContext: binding.context,
          taskExpiresAt: proposal.expiresAt,
          ...(protectedValueKind ? { protectedValueKind } : {}),
          signal: context.signal,
        },
      );
    } finally {
      await this.quiesce({ owner: context.owner, taskId: task.id });
    }
    if (!current()) return { status: "unknown" };
    const after = await this.snapshot(binding, context.signal);
    if (!current()) return { status: "unknown" };
    const status = await this.options.verify(proposal, cached.snapshot, after);
    if (!current()) return { status: "unknown" };
    const evidenceRef = await this.options.recordEvidence(
      task,
      proposal,
      cached.snapshot,
      after,
      status,
    );
    return { status, evidenceRef };
  }
}
