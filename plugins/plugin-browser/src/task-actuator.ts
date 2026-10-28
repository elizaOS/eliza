/** Host-composed task adapter. Product policy and evidence storage stay with the host. */
import {
  ElizaError,
  type InteractiveTask,
  sameTaskOwner,
  TASK_ACTION_NOT_DISPATCHED,
  type TaskActionProposal,
  type TaskObservation,
  type TaskOwner,
} from "@elizaos/core/protocol";
import {
  type NativeCommitGrant,
  type NativeSocketBrowserTarget,
  type NativeTaskBinding,
  type NativeTaskContext,
  type NativeTaskGuideAnswer,
  type NativeTaskGuideTone,
  validActionText,
  validCommitGrant,
} from "./native-socket-target.js";

export const TASK_BROWSER_BLOCKER_KINDS = [
  "modal",
  "cookie-consent",
  "captcha",
  "login-wall",
  "paywall",
] as const;
export const TASK_BROWSER_BLOCKER_COVERAGE = [
  "viewport",
  "target",
  "partial",
] as const;
/**
 * Something in front of the observed page that the person must deal with
 * first. It is reported, never answered: `ref` is a control of this snapshot
 * that closes it without agreeing to anything, `rejectRef` a consent banner's
 * reject or necessary-only control. A person check (captcha) never has a ref.
 * `covers` is most of the viewport, the centre of a listed control outside
 * it, or only part of the page. `text` is website data, not instructions.
 */
export interface TaskBrowserBlocker {
  kind: (typeof TASK_BROWSER_BLOCKER_KINDS)[number];
  ref?: string;
  rejectRef?: string;
  covers: (typeof TASK_BROWSER_BLOCKER_COVERAGE)[number];
  text?: string;
}
export interface TaskBrowserSnapshot {
  snapshotId: string;
  documentId: string;
  url: string;
  inputRevision: number;
  elements: Array<{ selector: string; [key: string]: unknown }>;
  /** Absent from browsers that predate blocker reports. */
  blockers?: TaskBrowserBlocker[];
  [key: string]: unknown;
}

/** Whether a snapshot's blocker report is well formed and names only its own elements. */
export function validTaskBrowserBlockers(
  snapshot: Pick<TaskBrowserSnapshot, "elements"> & { blockers?: unknown },
): boolean {
  if (snapshot.blockers === undefined) return true;
  if (!Array.isArray(snapshot.blockers)) return false;
  const selectors = new Set(
    snapshot.elements.map((element) => element.selector),
  );
  const optionalRef = (value: unknown) =>
    value === undefined || (typeof value === "string" && selectors.has(value));
  return snapshot.blockers.every((blocker: unknown) => {
    if (!blocker || typeof blocker !== "object" || Array.isArray(blocker))
      return false;
    const item = blocker as Record<string, unknown>;
    return (
      TASK_BROWSER_BLOCKER_KINDS.includes(
        item.kind as TaskBrowserBlocker["kind"],
      ) &&
      TASK_BROWSER_BLOCKER_COVERAGE.includes(
        item.covers as TaskBrowserBlocker["covers"],
      ) &&
      optionalRef(item.ref) &&
      optionalRef(item.rejectRef) &&
      (item.kind !== "captcha" ||
        (item.ref === undefined && item.rejectRef === undefined)) &&
      (item.rejectRef === undefined || item.kind === "cookie-consent") &&
      // A consent banner's close control may count as agreeing.
      (item.ref === undefined || item.kind !== "cookie-consent") &&
      (item.text === undefined ||
        (typeof item.text === "string" && item.text.length <= 200))
    );
  });
}
export interface TaskBrowserPolicy {
  tabId: string;
  /** The origin of the page the binding starts on. */
  origin: string;
  /**
   * Every origin this binding lets the page be observed and acted on, `origin`
   * included, each one of the task's `allowedOrigins`. Default: all allowed
   * origins of a task the host extended ("extend-origin"), otherwise `origin`
   * alone. Each action stays bound to the origin of its observation.
   */
  origins?: string[];
  leaseMs: number;
  targets: NativeTaskBinding["targets"];
}
function fail(message: string): never {
  throw new ElizaError(message, { code: "TASK_ACTION_DENIED" });
}
/** The actuator or the browser refused the action before it reached the page. */
function notDispatched(cause: unknown): never {
  throw new ElizaError("The browser action was not sent", {
    code: TASK_ACTION_NOT_DISPATCHED,
    cause,
  });
}
// The browser extension reports these kinds only before an effect runs.
const PRE_EFFECT_REFUSALS = new Set(["STALE_REF", "POLICY_BLOCKED"]);

export class NativeTaskActuator {
  readonly capabilities = [
    "browser.click",
    "browser.follow",
    "browser.fill",
    "browser.select",
    "browser.scroll.up",
    "browser.scroll.down",
    "browser.scroll.left",
    "browser.scroll.right",
  ] as const;
  private bindings = new Map<
    string,
    {
      context: NativeTaskContext;
      policy: TaskBrowserPolicy;
      expiresAt: number;
      readOnly: boolean;
    }
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
      /** Interpret a fresh read-only snapshot using durable host-owned provenance. */
      reconcile?: (
        task: InteractiveTask,
        proposal: TaskActionProposal,
        snapshot: TaskBrowserSnapshot,
      ) => Promise<
        | { status: "succeeded" | "failed"; evidenceRef: string }
        | { status: "unknown"; evidenceRef?: string }
      >;
      now?: () => number;
      /** Product display name for the browser overlay; host configuration. */
      assistantName?: string;
      /**
       * Apply a changed task origin scope to the page's own navigation policy,
       * for example the native surface's `setTaskOrigins`. Resolve once applied.
       */
      applyOrigins?: (
        task: InteractiveTask,
        allowedOrigins: readonly string[],
      ) => Promise<void>;
      /**
       * Trusted host wording for the action preview, for example "I will
       * choose your saved Visa." Without it the browser uses a generic line.
       */
      describeAction?: (
        task: InteractiveTask,
        proposal: TaskActionProposal,
      ) => string | undefined;
      /**
       * The host's single-use grant for this exact commit, issued only after
       * it recorded the person's explicit yes to this step, control and value.
       * Return undefined for every other action; the browser then keeps
       * blocking commits. The proposal must name its reviewed control
       * (`expectedSelector`).
       */
      commitGrant?: (
        task: InteractiveTask,
        proposal: TaskActionProposal,
      ) => NativeCommitGrant | undefined;
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
  private async bind(task: InteractiveTask, readOnly = false) {
    const cached = this.bindings.get(task.id);
    // An active task renews an expired lease with a new binding revision when
    // it observes again. An action still needs an observation under the
    // current lease, so the lease cannot outlive the page facts it acted on.
    if (
      !readOnly &&
      cached &&
      !cached.readOnly &&
      cached.context.epoch === task.epoch &&
      cached.expiresAt > this.now()
    )
      return cached;
    const policy = structuredClone(this.options.policy(task));
    const origins =
      policy.origins ??
      (task.originGrants ? [...task.allowedOrigins] : [policy.origin]);
    if (
      !Array.isArray(origins) ||
      !origins.includes(policy.origin) ||
      new Set(origins).size !== origins.length ||
      origins.some((origin) => !task.allowedOrigins.includes(origin)) ||
      !Number.isSafeInteger(policy.leaseMs) ||
      policy.leaseMs < 1 ||
      policy.leaseMs > 300000
    )
      fail("Invalid task browser policy");
    policy.origins = origins;
    if (readOnly) policy.targets = [];
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
      // Single-origin bindings keep their original wire form.
      ...(origins.length > 1 ? { origins } : {}),
      expiresAt: this.now() + policy.leaseMs,
      targets: policy.targets,
      revoked: false,
      ...(this.options.assistantName === undefined
        ? {}
        : { assistantName: this.options.assistantName }),
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
    const entry = { context, policy, expiresAt: binding.expiresAt, readOnly };
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
      !binding.policy.origins?.includes(new URL(frame.url).origin) ||
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
    if (!validTaskBrowserBlockers(snapshot))
      fail("Invalid browser page blocker report");
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
      // The observed page's own origin; actions stay bound to this observation.
      origin: new URL(snapshot.url).origin,
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
  /**
   * The runtime persisted a new origin scope under a new epoch. Remove guidance
   * and page facts from the old scope; the next observation binds the new one.
   * Then the host applies the scope to the page's navigation policy.
   */
  async scopeChanged(context: {
    owner: TaskOwner;
    taskId: string;
    epoch: number;
    allowedOrigins: readonly string[];
  }): Promise<void> {
    const task = this.options.getTask(context.taskId);
    if (
      !sameTaskOwner(task.owner, context.owner) ||
      task.epoch !== context.epoch
    )
      fail("Task scope changed again");
    this.observations.delete(task.id);
    await this.quiesce({ owner: context.owner, taskId: task.id });
    // Never write an origin list a newer scope change already replaced.
    if (this.options.getTask(task.id).epoch !== context.epoch)
      fail("Task scope changed again");
    await this.options.applyOrigins?.(task, [...context.allowedOrigins]);
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

  /**
   * Host-owned guidance text/target; no renderer-supplied DOM or authorization.
   * The returned revision identifies this guide's offer answers
   * (`NativeSocketBrowserTarget.onTaskGuideAnswer`).
   */
  async showGuidance(
    taskId: string,
    owner: TaskOwner,
    input: {
      stepId: string;
      targetRef: string;
      text: string;
      detail?: string;
      tone?: NativeTaskGuideTone;
      answers?: NativeTaskGuideAnswer[];
      restore?: boolean;
      /** Observed controls the label must not cover. */
      keepClearRefs?: string[];
    },
    signal: AbortSignal,
  ): Promise<{
    tabId: string;
    revision: number;
    expiresAt: number;
    /** Where the target was when shown; "scrolled" means it was brought into view. */
    placement?: "in-view" | "scrolled" | "off-screen" | "hidden";
    /** The person dismissed this step earlier; it stays hidden until restored. */
    dismissed?: boolean;
  }> {
    const task = this.task(taskId, owner);
    const { snapshot } = this.readObservation(taskId, owner);
    const binding = this.bindings.get(taskId);
    const guide = this.options.target.guideTask;
    if (
      task.status !== "active" ||
      !binding ||
      !guide ||
      !snapshot.elements.some(
        (element) => element.selector === input.targetRef,
      ) ||
      input.keepClearRefs?.some(
        (ref) => !snapshot.elements.some((element) => element.selector === ref),
      )
    )
      fail("Guidance requires an active observed task target");
    signal.throwIfAborted();
    const revision = (this.guidanceRevisions.get(taskId) ?? 0) + 1;
    this.guidanceRevisions.set(taskId, revision);
    this.activeGuidance.add(taskId);
    const expiresAt = Math.min(binding.expiresAt, this.now() + 60000);
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
          detail: input.detail,
          tone: input.tone,
          answers: input.answers,
          restore: input.restore,
          ...(input.keepClearRefs?.length
            ? { keepClear: input.keepClearRefs }
            : {}),
          expiresAt,
        },
        signal,
      )) as { accepted?: boolean; placement?: unknown; dismissed?: unknown };
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
      return {
        tabId: binding.policy.tabId,
        revision,
        expiresAt,
        ...(["in-view", "scrolled", "off-screen", "hidden"].includes(
          reply.placement as string,
        )
          ? {
              placement: reply.placement as
                | "in-view"
                | "scrolled"
                | "off-screen"
                | "hidden",
            }
          : {}),
        ...(reply.dismissed === true ? { dismissed: true } : {}),
      };
    } catch (error) {
      if (this.guidanceRevisions.get(taskId) === revision)
        await this.quiesce({ owner, taskId });
      throw error;
    }
  }

  /**
   * Product Pause: removes the label and its answers and leaves a paused,
   * show-only cursor. Like `quiesce`, it may run after task revocation.
   */
  async pauseGuidance({
    owner,
    taskId,
  }: {
    owner: TaskOwner;
    taskId: string;
  }): Promise<void> {
    if (!this.activeGuidance.has(taskId)) return;
    const binding = this.guidanceOwner(owner, taskId);
    const revision = (this.guidanceRevisions.get(taskId) ?? 0) + 1;
    this.guidanceRevisions.set(taskId, revision);
    const reply = (await binding.guide.call(this.options.target, {
      kind: "pause",
      tabId: binding.tabId,
      taskContext: binding.context,
      revision,
    })) as { visible?: boolean };
    if (
      reply?.visible !== false ||
      this.guidanceRevisions.get(taskId) !== revision
    )
      fail("Guidance pause was not acknowledged");
  }

  private guidanceOwner(owner: TaskOwner, taskId: string) {
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
    return { guide, context: binding.context, tabId: binding.policy.tabId };
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
    const binding = this.guidanceOwner(owner, taskId);
    const revision = (this.guidanceRevisions.get(taskId) ?? 0) + 1;
    this.guidanceRevisions.set(taskId, revision);
    const reply = (await binding.guide.call(this.options.target, {
      kind: "hide",
      tabId: binding.tabId,
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

  /** Fresh readback under an empty target allowlist; never caches an action observation. */
  async reconcile(
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
    const task = this.options.getTask(proposal.taskId);
    const operation = task.operations.find(
      (op) => op.proposal.id === proposal.id,
    );
    if (
      !this.options.reconcile ||
      !sameTaskOwner(task.owner, context.owner) ||
      task.authorization.state !== "active" ||
      !["paused", "blocked", "cancelled"].includes(task.status) ||
      operation?.status !== "unknown" ||
      operation.proposal.authorizationId !== task.authorization.decisionId
    )
      fail("No authorized unknown browser operation");
    const requireCurrent = () => {
      context.signal.throwIfAborted();
      const current = this.options.getTask(task.id);
      if (
        !context.isCurrent() ||
        !sameTaskOwner(current.owner, context.owner) ||
        current.revision !== task.revision ||
        current.epoch !== task.epoch ||
        current.authorization.state !== "active"
      )
        fail("Readback authority changed");
    };
    requireCurrent();
    await this.quiesce({ owner: context.owner, taskId: task.id });
    this.observations.delete(task.id);
    const binding = await this.bind(task, true);
    requireCurrent();
    const snapshot = await this.snapshot(binding, context.signal);
    requireCurrent();
    const result = await this.options.reconcile(
      task,
      operation.proposal,
      snapshot,
    );
    requireCurrent();
    return result;
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
    let prepared: Awaited<ReturnType<NativeTaskActuator["prepareDispatch"]>>;
    try {
      prepared = await this.prepareDispatch(proposal, context);
    } catch (error) {
      // Nothing reached the browser yet.
      notDispatched(error);
    }
    const {
      task,
      cached,
      binding,
      current,
      command,
      protectedValueKind,
      actionText,
      commitGrant,
    } = prepared;
    // Preparation awaits host callbacks; authority may end before this continuation.
    if (
      !current() ||
      this.now() >= proposal.expiresAt ||
      binding.expiresAt <= this.now()
    )
      notDispatched(new Error("Action authority ended before dispatch"));
    let uncertainFollow = false;
    try {
      await this.options.target.execute(command, {
        taskContext: binding.context,
        taskExpiresAt: proposal.expiresAt,
        ...(protectedValueKind ? { protectedValueKind } : {}),
        ...(actionText ? { actionText } : {}),
        ...(proposal.expectedSelector === undefined
          ? {}
          : { expectedSelector: proposal.expectedSelector }),
        ...(commitGrant ? { commitGrant } : {}),
        signal: context.signal,
      });
    } catch (error) {
      await this.quiesce({ owner: context.owner, taskId: task.id });
      const kind = (error as { kind?: unknown } | null)?.kind;
      if (typeof kind === "string" && PRE_EFFECT_REFUSALS.has(kind))
        notDispatched(error);
      // A same-origin observed follow can destroy its reply channel. Never
      // repeat it. Only this navigation operation may continue to fresh
      // destination readback; other uncertain effects retain explicit recovery.
      if (
        proposal.capability !== "browser.follow" ||
        kind !== "UNCERTAIN_OUTCOME"
      )
        throw error;
      uncertainFollow = true;
    }
    await this.quiesce({ owner: context.owner, taskId: task.id });
    if (!current()) return { status: "unknown" };
    const after = await this.snapshot(binding, context.signal);
    if (!current()) return { status: "unknown" };
    // The page tried to submit or leave because of this action. The browser
    // stopped it, but the page state is no longer the one that was reviewed.
    if (after.effectViolation !== undefined) return { status: "unknown" };
    if (uncertainFollow) {
      const targets = cached.snapshot.elements.filter(
        (element) =>
          element.selector === proposal.targetRef &&
          element.targetSelector === proposal.expectedSelector,
      );
      try {
        if (targets.length !== 1 || typeof targets[0].href !== "string")
          return { status: "unknown" };
        const destination = new URL(targets[0].href);
        if (
          destination.protocol !== "https:" ||
          destination.username ||
          destination.password ||
          destination.origin !== new URL(cached.snapshot.url).origin ||
          destination.href === new URL(cached.snapshot.url).href ||
          destination.href !== new URL(after.url).href
        )
          return { status: "unknown" };
      } catch {
        return { status: "unknown" };
      }
    }
    // A commit the browser let through must be the one this grant named.
    // The page's report then reaches verify and evidence with the snapshot.
    const consented = after.consentedCommit as
      | { grantId?: unknown; kind?: unknown; formHash?: unknown }
      | undefined;
    if (
      consented !== undefined &&
      (!commitGrant ||
        consented.grantId !== commitGrant.grantId ||
        // The page refuses a submit whose form data differs; a report that
        // still differs is not the commit the person said yes to.
        (commitGrant.formHash !== undefined &&
          consented.formHash !== undefined &&
          consented.formHash !== commitGrant.formHash))
    )
      return { status: "unknown" };
    // Occupancy alone cannot verify a public fill: page handlers can replace it.
    // The isolated page compares against the text from the actual dispatched fill.
    if (proposal.capability === "browser.fill" && !protectedValueKind) {
      const readback = after.inputReadback as
        | { targetRef?: unknown; matches?: unknown }
        | undefined;
      if (
        after.documentId !== cached.snapshot.documentId ||
        readback?.targetRef !== proposal.targetRef ||
        readback.matches !== true
      )
        return { status: "unknown" };
    }
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

  /** Every check before the effect. A throw here means nothing was sent. */
  private async prepareDispatch(
    proposal: TaskActionProposal,
    context: {
      owner: TaskOwner;
      signal: AbortSignal;
      isCurrent: () => boolean;
    },
  ) {
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
    // A host-chosen reviewed target must be one this binding allows for this
    // action. The browser then checks that the node is that target only.
    if (
      proposal.expectedSelector !== undefined &&
      !binding.policy.targets.some(
        (target) =>
          target.selector === proposal.expectedSelector &&
          (target.action === proposal.capability.split(".")[1] ||
            (target.action === "fill-code" &&
              proposal.capability === "browser.fill")),
      )
    )
      fail("The expected target is not a reviewed target for this action");
    const direction = proposal.capability.split(".")[2] as
      | "up"
      | "down"
      | "left"
      | "right"
      | undefined;
    const subaction = proposal.capability.split(".")[1] as
      | "click"
      | "fill"
      | "select"
      | "scroll"
      | "follow";
    const resolved = ["fill", "select"].includes(subaction)
      ? await this.options.resolveValue(
          proposal.valueRef ||
            fail("Fill or select requires a held value reference"),
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
    if (subaction === "select" && protectedValueKind)
      fail("Select cannot use a protected value");
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
    const actionText = this.options.describeAction?.(task, proposal);
    if (actionText !== undefined && !validActionText(actionText))
      fail("Invalid action sentence");
    const commitGrant = this.options.commitGrant
      ? structuredClone(this.options.commitGrant(task, proposal))
      : undefined;
    if (
      commitGrant !== undefined &&
      (["scroll", "follow"].includes(subaction) ||
        !validCommitGrant(commitGrant, {
          taskContext: binding.context,
          subaction,
          targetRef: proposal.targetRef,
          selector: proposal.expectedSelector,
          now: this.now(),
        }) ||
        // The page the person said yes on: for an extended task this is the
        // observed origin, never just the binding's starting origin.
        commitGrant.origin !== cached.observation.origin)
    )
      fail("The commit grant does not match this action");
    if (!current()) fail("Action cancelled before dispatch");
    return {
      task,
      cached,
      binding,
      current,
      protectedValueKind,
      actionText,
      commitGrant,
      command: {
        subaction,
        id: binding.policy.tabId,
        selector: proposal.targetRef,
        ...(text === undefined ? {} : { text }),
        ...(subaction === "scroll" ? { direction } : {}),
      },
    };
  }
}
