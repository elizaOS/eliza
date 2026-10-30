/**
 * Framework-free controller for an on-device ("resident") agent's Eliza Cloud inference binding.
 *
 * The agent always runs on the device. This controller decides only whether Eliza Cloud
 * inference is bound to it, from the saved Cloud sign-in, the verified identity and the plan
 * Cloud reports, and applies that decision through host ports. It owns the rules a host must not
 * re-derive in its UI:
 *
 * - `admit`: one account and plan read. No saved sign-in, a rejected sign-in, a plan that ended or
 *   an unknown plan leaves inference unbound. A changed account between reads is refused.
 * - The offline rule: while Cloud is unreachable, a plan this same sign-in verified within
 *   `OFFLINE_PLAN_GRACE_MS` (7 days) and whose period has not ended keeps its binding (`kept`);
 *   otherwise inference is unbound. Cloud still decides every request once reachable.
 * - `apply`: binds or clears the provider and confirms the credential did not change meanwhile.
 *   A failed bind is cleared; a removal the host cannot confirm is reported as `unknown`.
 * - `requestRebind` (`ResidentRebindQueue`): at most one rebind runs; one more is queued behind it.
 * - `replaceCredential`: a new key revokes the key it replaces first (once, best effort) and only
 *   then stores the new one.
 * - `beginSignIn`: one sign-in step at a time; cancelling the step aborts it.
 *
 * Ports supply the credential store, provider bind/clear, identity, entitlement and the plan
 * admission record. Nothing here renders, names a product, or reads a credential's secret: the
 * controller sees only credential ids. Dependency-free on purpose so products can project this
 * single file from the pinned source; it avoids parameter properties so type stripping loads it.
 */

/** A verified Cloud billing mode within this window keeps its binding while Cloud is unreachable. */
export const OFFLINE_PLAN_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** What a host stores to recognize a recent verified plan while Cloud is unreachable. */
export interface ResidentPlanAdmissionRecord<E extends string = string> {
  version: 1;
  environment: E;
  credentialId: string;
  userId: string;
  organizationId: string | null;
  status: "active" | "trialing" | "past_due" | "credit-funded";
  planName: string;
  verifiedAt: number;
  endsAt: number | null;
}

/** The saved sign-in, by id only. */
export interface ResidentCredentialRef {
  credentialId: string;
}

/** The identity Cloud verified for the saved sign-in. */
export interface ResidentIdentity {
  credentialId: string;
  userId: string;
  organizationId: string | null;
}

/** How the plan read decided, independent of any UI copy. */
export type ResidentPlanDecision =
  | "admit"
  | "admit-with-warning"
  | "needs-plan"
  | "unknown";

/** One plan read for a verified identity. `outage` marks an unknown plan caused by a billing outage. */
export interface ResidentPlanCheck<V = unknown> {
  decision: ResidentPlanDecision;
  /** The host's plan view (for example a cloud-sdk SubscriptionView), returned unchanged. */
  view: V;
  /** True only when the plan is unknown because billing could not be read. */
  outage: boolean;
  /** What to record for an admitted plan; null when nothing should be recorded. */
  record: {
    status: ResidentPlanAdmissionRecord["status"];
    planName: string;
  } | null;
  /** End of the admitted plan window when Cloud reported one; null for no end; undefined when unknown. */
  endsAt?: number | null;
}

export type ResidentBinding = "cloud" | "unbound" | "kept";

/** Why the binding is what it is; hosts map these to their own copy. */
export type ResidentAdmissionReason =
  | "admitted"
  | "signed-out"
  | "sign-in-rejected"
  | "account-changed"
  | "offline"
  | "needs-plan"
  | "plan-unavailable";

export interface ResidentAdmission<V = unknown> {
  binding: ResidentBinding;
  reason: ResidentAdmissionReason;
  /** Present once the identity was verified. */
  identity?: ResidentIdentity;
  /** Present once the plan was read. */
  plan?: ResidentPlanCheck<V>;
  /** The recent verified plan this sign-in holds, when one exists. */
  recent?: ResidentPlanAdmissionRecord | null;
  /** The plan window in effect: the reported end, else the recent record's end. */
  endsAt?: number | null;
  /** The underlying error for a rejected or unreachable read. */
  error?: unknown;
}

export interface ResidentApplyResult {
  binding: "cloud" | "unbound" | "kept" | "unknown";
  /** Set when binding failed (`cause`) or a removal could not be confirmed (`unconfirmed`). */
  failure?: { kind: "bind-failed" | "unbind-unconfirmed"; cause?: unknown };
}

export interface CloudResidentBindingPorts<
  V = unknown,
  E extends string = string,
> {
  /** The saved sign-in for this environment, or null when signed out. */
  readCredential(signal: AbortSignal): Promise<ResidentCredentialRef | null>;
  /** Verifies the saved sign-in with Cloud. Throws for a rejected or unreachable read. */
  verifyIdentity(signal: AbortSignal): Promise<ResidentIdentity>;
  /** One plan read for the verified identity. Throws for a rejected or unreachable read. */
  checkPlan(
    identity: ResidentIdentity,
    signal: AbortSignal,
  ): Promise<ResidentPlanCheck<V>>;
  /** Binds Cloud inference and optionally returns the opaque identity/generation
   * guard captured atomically for this invocation's applied or attached binding.
   * Legacy hosts can return void, but cannot perform automatic failed-bind cleanup. */
  bindProvider(
    credentialId: string,
    signal: AbortSignal,
    // biome-ignore lint/suspicious/noConfusingVoidType: existing host ports return Promise<void>.
  ): Promise<void | string>;
  /** Clears only the exact binding represented by the guard, checking it under
   * the host's existing lifecycle/storage lock before and after any shutdown.
   * A changed binding must remain untouched. Never implement with read-then-clear. */
  clearProviderIfCurrent?(
    bindingGuard: string,
    signal: AbortSignal,
  ): Promise<"cleared" | "changed">;
  /**
   * Removes any Cloud inference binding. Throws when the removal cannot be confirmed. `reason` is
   * `unbound` for a plain unbind (a host may skip work when nothing is stored) and `bind-failed`
   * after a bind that failed or was refused.
   */
  clearProvider(
    signal: AbortSignal,
    reason: "unbound" | "bind-failed",
  ): Promise<void>;
  /** The stored plan admission record, already parsed; null when absent or unreadable. */
  readAdmission(): ResidentPlanAdmissionRecord<E> | null;
  /** Stores (or clears, with null) the plan admission record. Best effort. */
  writeAdmission(record: ResidentPlanAdmissionRecord<E> | null): void;
  /** A Cloud outage or no network: not a refusal of the account or the plan. */
  isUnreachable(error: unknown): boolean;
  /** A rejected sign-in, an entitlement for another account, or a changed account. */
  isSignInRejected(error: unknown): boolean;
  /** An error the host must rethrow from `apply` without clearing (for example a stop it could not confirm). */
  isFatalBindError?(error: unknown): boolean;
  now?(): number;
}

export class CloudResidentBindingError extends Error {
  readonly code: "account-changed" | "login-active";
  constructor(code: "account-changed" | "login-active") {
    super(
      code === "account-changed"
        ? "Cloud account changed. Sign in again."
        : "Another Cloud sign-in is in progress.",
    );
    this.name = "CloudResidentBindingError";
    this.code = code;
  }
}

const RECORD_STATUSES = new Set([
  "active",
  "trialing",
  "past_due",
  "credit-funded",
]);

/** Parses a stored admission record; anything malformed is null. */
export function parseResidentPlanAdmission<E extends string>(
  value: unknown,
  environmentAllowed: (environment: unknown) => environment is E,
): ResidentPlanAdmissionRecord<E> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1 ||
    !environmentAllowed(row.environment) ||
    typeof row.credentialId !== "string" ||
    typeof row.userId !== "string" ||
    typeof row.status !== "string" ||
    !RECORD_STATUSES.has(row.status) ||
    typeof row.planName !== "string" ||
    typeof row.verifiedAt !== "number" ||
    !Number.isFinite(row.verifiedAt)
  )
    return null;
  return {
    version: 1,
    environment: row.environment,
    credentialId: row.credentialId,
    userId: row.userId,
    organizationId:
      typeof row.organizationId === "string" ? row.organizationId : null,
    status: row.status as ResidentPlanAdmissionRecord["status"],
    planName: row.planName,
    verifiedAt: row.verifiedAt,
    endsAt:
      typeof row.endsAt === "number" && Number.isFinite(row.endsAt)
        ? row.endsAt
        : null,
  };
}

/**
 * The recent admitting plan this credential holds, or null: same environment and credential (and
 * user, when given), verified within the grace window, and its period not ended.
 */
export function recentResidentPlanAdmission<E extends string>(
  record: ResidentPlanAdmissionRecord<E> | null,
  environment: E,
  credentialId: string | undefined,
  userId: string | undefined,
  now: number,
): ResidentPlanAdmissionRecord<E> | null {
  if (
    !record ||
    !credentialId ||
    record.environment !== environment ||
    record.credentialId !== credentialId ||
    (userId !== undefined &&
      record.userId.toLowerCase() !== userId.toLowerCase())
  )
    return null;
  if (record.endsAt !== null && record.endsAt <= now) return null;
  const age = now - record.verifiedAt;
  return age >= 0 && age <= OFFLINE_PLAN_GRACE_MS ? record : null;
}

/**
 * At most one rebind of the running resident runs; one more is queued behind it and further
 * requests coalesce. A host whose admission controller is short-lived (one per account read) keeps
 * one of these for the life of the resident so the rule survives across admissions.
 *
 * Every caller learns the outcome of the run that serves it: a request that runs now gets that
 * run's promise; a request that coalesces into the queued run gets the queued run's promise, which
 * resolves or rejects with that run's own result. Nothing is swallowed.
 */
export class ResidentRebindQueue {
  private running: Promise<void> | null = null;
  private next: {
    rebind: () => Promise<void>;
    blocked: () => boolean;
    promise: Promise<void>;
    resolve: () => void;
    reject: (error: unknown) => void;
  } | null = null;
  private wanted = false;

  /**
   * Runs `rebind` now, or queues it behind the running one. `blocked` lets the host defer the run
   * (another operation is in progress); call `resume` once that ends. The queued run uses the
   * latest coalesced caller's `rebind` and `blocked`. The returned promise settles with the run
   * that serves this call; a deferred request settles once the host resumes it.
   */
  request(
    rebind: () => Promise<void>,
    blocked: () => boolean = () => false,
  ): Promise<void> {
    if (!this.running && !blocked()) return this.runNow(rebind);
    if (!this.next) {
      let resolve: () => void = () => {};
      let reject: (error: unknown) => void = () => {};
      const promise = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      // Coalesced callers may discard this promise; awaiting callers still see the rejection.
      promise.catch(() => {});
      this.next = { rebind, blocked, promise, resolve, reject };
    }
    this.next.rebind = rebind;
    this.next.blocked = blocked;
    return this.next.promise;
  }

  /** Whether a rebind is waiting for the current work to end. */
  get pending(): boolean {
    return this.wanted || this.next !== null;
  }

  /** Whether a rebind is running now. */
  get active(): boolean {
    return this.running !== null;
  }

  /** Marks a rebind as wanted without running it (the host runs it with `resume` once idle). */
  queue(): void {
    this.wanted = true;
  }

  /**
   * Runs a wanted or queued rebind with the host's `rebind` when nothing is running and nothing
   * blocks it. Callers that coalesced into the queued run receive this run's outcome.
   */
  resume(
    rebind: () => Promise<void>,
    blocked: () => boolean = () => false,
  ): Promise<void> | undefined {
    if (!this.pending || this.running || blocked()) return undefined;
    return this.runNow(rebind);
  }

  /** Starts `rebind` now; a queued request it supersedes settles with this run. */
  private runNow(rebind: () => Promise<void>): Promise<void> {
    const waiting = this.next;
    this.next = null;
    const run = this.start(rebind);
    if (waiting) run.then(waiting.resolve, waiting.reject);
    return run;
  }

  private start(rebind: () => Promise<void>): Promise<void> {
    this.wanted = false;
    const run = (async () => {
      try {
        await rebind();
      } finally {
        this.running = null;
      }
    })();
    this.running = run;
    const drain = () => this.drain();
    run.then(drain, drain);
    return run;
  }

  /**
   * Starts the queued run once the running one settles, unless the host is still busy. A
   * flag-only `queue()` has no caller to report to, so it waits for the host's `resume`.
   */
  private drain(): void {
    const waiting = this.next;
    if (this.running || !waiting || waiting.blocked()) return;
    this.next = null;
    this.start(waiting.rebind).then(waiting.resolve, waiting.reject);
  }
}

export class CloudResidentBindingController<
  V = unknown,
  E extends string = string,
> {
  private readonly rebinds = new ResidentRebindQueue();
  private signIn: AbortController | null = null;

  readonly environment: E;
  private readonly ports: CloudResidentBindingPorts<V, E>;
  // Explicit fields (no parameter properties) so type-stripping consumers can load this file.
  constructor(environment: E, ports: CloudResidentBindingPorts<V, E>) {
    this.environment = environment;
    this.ports = ports;
  }

  private now(): number {
    return this.ports.now?.() ?? Date.now();
  }

  /** The recent verified plan for this sign-in (the 7-day offline rule), or null. */
  recentAdmission(
    credentialId: string | undefined,
    userId?: string,
  ): ResidentPlanAdmissionRecord<E> | null {
    return recentResidentPlanAdmission(
      this.ports.readAdmission(),
      this.environment,
      credentialId,
      userId,
      this.now(),
    );
  }

  /** Records a verified admitting plan for the offline rule. */
  recordAdmission(
    identity: ResidentIdentity,
    record: NonNullable<ResidentPlanCheck["record"]>,
    endsAt: number | null,
  ): void {
    this.ports.writeAdmission({
      version: 1,
      environment: this.environment,
      credentialId: identity.credentialId,
      userId: identity.userId,
      organizationId: identity.organizationId,
      status: record.status,
      planName: record.planName,
      verifiedAt: this.now(),
      endsAt,
    });
  }

  /** Cloud reported the plan ended: the offline rule no longer applies to it. */
  forgetAdmission(): void {
    this.ports.writeAdmission(null);
  }

  private offline(
    credentialId: string,
    userId: string | undefined,
    error: unknown,
    identity?: ResidentIdentity,
  ): ResidentAdmission<V> {
    const recent = this.recentAdmission(credentialId, userId);
    return {
      binding: recent ? "kept" : "unbound",
      reason: "offline",
      recent,
      endsAt: recent?.endsAt ?? null,
      error,
      ...(identity ? { identity } : {}),
    };
  }

  private async assertSameCredential(
    credentialId: string,
    signal: AbortSignal,
  ): Promise<void> {
    const current = await this.ports.readCredential(signal);
    signal.throwIfAborted();
    if (current?.credentialId !== credentialId)
      throw new CloudResidentBindingError("account-changed");
  }

  /**
   * Reads the saved sign-in, identity and plan and decides the inference binding only. It never
   * decides whether the agent runs.
   */
  async admit(signal: AbortSignal): Promise<ResidentAdmission<V>> {
    signal.throwIfAborted();
    const saved = await this.ports.readCredential(signal);
    signal.throwIfAborted();
    if (!saved?.credentialId)
      return { binding: "unbound", reason: "signed-out" };
    let identity: ResidentIdentity;
    try {
      identity = await this.ports.verifyIdentity(signal);
      signal.throwIfAborted();
      if (identity.credentialId !== saved.credentialId)
        throw new CloudResidentBindingError("account-changed");
    } catch (error) {
      signal.throwIfAborted();
      if (this.ports.isUnreachable(error))
        return this.offline(saved.credentialId, undefined, error);
      return {
        binding: "unbound",
        reason:
          error instanceof CloudResidentBindingError
            ? "account-changed"
            : "sign-in-rejected",
        error,
      };
    }
    let plan: ResidentPlanCheck<V>;
    try {
      plan = await this.ports.checkPlan(identity, signal);
      signal.throwIfAborted();
      await this.assertSameCredential(identity.credentialId, signal);
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof CloudResidentBindingError)
        return {
          binding: "unbound",
          reason: "account-changed",
          identity,
          error,
        };
      if (this.ports.isSignInRejected(error))
        return {
          binding: "unbound",
          reason: "sign-in-rejected",
          identity,
          error,
        };
      if (this.ports.isUnreachable(error))
        return this.offline(
          identity.credentialId,
          identity.userId,
          error,
          identity,
        );
      return {
        binding: "unbound",
        reason: "plan-unavailable",
        identity,
        error,
      };
    }
    const recent = this.recentAdmission(identity.credentialId, identity.userId);
    let decision = plan.decision;
    // A billing outage after a recent verified plan keeps the binding: Cloud decides each request.
    if (decision === "unknown" && plan.outage && recent)
      decision = recent.status === "past_due" ? "admit-with-warning" : "admit";
    const endsAt =
      plan.endsAt !== undefined ? plan.endsAt : (recent?.endsAt ?? null);
    if (decision === "needs-plan" || decision === "unknown") {
      if (decision === "needs-plan") this.forgetAdmission();
      return {
        binding: "unbound",
        reason: "needs-plan",
        identity,
        plan,
        recent,
        endsAt: null,
      };
    }
    if (plan.record) this.recordAdmission(identity, plan.record, endsAt);
    return {
      binding: "cloud",
      reason: "admitted",
      identity,
      plan,
      recent,
      endsAt,
    };
  }

  /** Binds or unbinds Cloud inference before the agent starts. Returns the binding in effect. */
  async apply(
    admission: Pick<ResidentAdmission<V>, "binding" | "identity">,
    signal: AbortSignal,
  ): Promise<ResidentApplyResult> {
    if (admission.binding === "kept") return { binding: "kept" };
    const credentialId = admission.identity?.credentialId;
    if (admission.binding === "cloud" && credentialId) {
      await this.assertSameCredential(credentialId, signal);
      let bindingGuard: string | undefined;
      try {
        const appliedGuard = await this.ports.bindProvider(
          credentialId,
          signal,
        );
        bindingGuard =
          typeof appliedGuard === "string" ? appliedGuard : undefined;
        signal.throwIfAborted();
        await this.assertSameCredential(credentialId, signal);
        return { binding: "cloud" };
      } catch (error) {
        if (this.ports.isFatalBindError?.(error)) throw error;
        // A cancelled apply leaves the provider as it is: whatever cancelled it (a newer admission,
        // a sign-out or a reset) owns the binding next and applies or clears it. Clearing here
        // could remove the newer operation's binding. Cloud still refuses a revoked key at use.
        signal.throwIfAborted();
        // An old completion must not mint a fresh native clear intent after a
        // different Activity has replaced the sign-in. A bind failure is only
        // eligible for cleanup while its original credential is still current.
        if (error instanceof CloudResidentBindingError) throw error;
        await this.assertSameCredential(credentialId, signal);
        if (
          typeof bindingGuard !== "string" ||
          !bindingGuard ||
          !this.ports.clearProviderIfCurrent
        ) {
          return {
            binding: "unknown",
            failure: { kind: "bind-failed", cause: error },
          };
        }
        try {
          const cleared = await this.ports.clearProviderIfCurrent(
            bindingGuard,
            signal,
          );
          signal.throwIfAborted();
          if (cleared !== "cleared") {
            return {
              binding: "unknown",
              failure: { kind: "bind-failed", cause: error },
            };
          }
        } catch {
          signal.throwIfAborted();
          return {
            binding: "unknown",
            failure: { kind: "bind-failed", cause: error },
          };
        }
        signal.throwIfAborted();
        return {
          binding: "unbound",
          failure: { kind: "bind-failed", cause: error },
        };
      }
    }
    try {
      await this.ports.clearProvider(signal, "unbound");
    } catch {
      signal.throwIfAborted();
      return { binding: "unknown", failure: { kind: "unbind-unconfirmed" } };
    }
    signal.throwIfAborted();
    return { binding: "unbound" };
  }

  /** Runs `rebind` now or queues it; see `ResidentRebindQueue.request`. */
  requestRebind(
    rebind: () => Promise<void>,
    blocked: () => boolean = () => false,
  ): Promise<void> {
    return this.rebinds.request(rebind, blocked);
  }

  /** Whether a rebind is waiting for the current work to end. */
  get rebindPending(): boolean {
    return this.rebinds.pending;
  }

  /** Marks a rebind as wanted without running it (the host runs it once idle). */
  queueRebind(): void {
    this.rebinds.queue();
  }

  /** Runs a queued rebind when nothing blocks it. */
  resumeQueued(
    rebind: () => Promise<void>,
    blocked: () => boolean = () => false,
  ): Promise<void> | undefined {
    return this.rebinds.resume(rebind, blocked);
  }

  /**
   * Starts one sign-in step. Throws `login-active` while another runs. The returned signal aborts
   * when the caller's signal aborts or `cancelSignIn` is called; `end` must be called when done.
   */
  beginSignIn(signal: AbortSignal): { signal: AbortSignal; end: () => void } {
    if (this.signIn) throw new CloudResidentBindingError("login-active");
    signal.throwIfAborted();
    const controller = new AbortController();
    this.signIn = controller;
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    return {
      signal: controller.signal,
      end: () => {
        signal.removeEventListener("abort", abort);
        if (this.signIn === controller) this.signIn = null;
      },
    };
  }

  /** Whether a sign-in step is running. */
  get signInActive(): boolean {
    return this.signIn !== null;
  }

  /** Cancels the running sign-in step, if any. The stored sign-in is left as it was. */
  cancelSignIn(
    reason: unknown = new DOMException("Sign-in cancelled", "AbortError"),
  ): void {
    this.signIn?.abort(reason);
  }

  /**
   * Stores a newly issued sign-in. A different key already saved is revoked first (once, best
   * effort; a failed or unconfirmed revocation never blocks the new sign-in), then the new key is
   * written. Returns what happened to the replaced key; undefined when nothing was replaced.
   */
  static async replaceCredential<C>(
    input: {
      read: () => Promise<C | null>;
      same: (previous: C, issued: C) => boolean;
      revoke: (previous: C, signal: AbortSignal) => Promise<boolean>;
      write: (issued: C, signal: AbortSignal) => Promise<void>;
    },
    issued: C,
    signal: AbortSignal,
  ): Promise<"revoked" | "unconfirmed" | undefined> {
    let previous: C | null;
    let outcome: "revoked" | "unconfirmed" | undefined;
    try {
      previous = await input.read();
    } catch {
      previous = null;
      outcome = "unconfirmed";
    }
    signal.throwIfAborted();
    if (previous && !input.same(previous, issued)) {
      try {
        outcome = (await input.revoke(previous, signal))
          ? "revoked"
          : "unconfirmed";
      } catch {
        outcome = "unconfirmed";
      }
    }
    signal.throwIfAborted();
    await input.write(issued, signal);
    return outcome;
  }
}
