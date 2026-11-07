/**
 * Renderer side of the shared native notice routes (`plugin-native-notifications`
 * `NoticeRoutes` and `NoticeCoordinator`). Pure and browser-safe: Web Crypto only,
 * no Node, storage or transport imports.
 *
 * - `NoticeOwnerCoordinator` publishes the owner privacy fence to the native host
 *   once per owner change and runs the read-only revalidation of a returning
 *   owner's suspended notices on the host's notice work queue.
 * - `resolveNoticeTap` opens a captured notice tap only through authenticated
 *   reads of its exact route. A tap is a read request: it never starts, retries,
 *   approves or decides anything.
 * - `workflowApprovalNoticeIdentity` and `revalidateWorkflowApprovalNotice` bind a
 *   phone-step approval notice to its exact run route and decide whether a
 *   suspended notice may be reposted quietly when its owner returns.
 */

/** Owner identity shared by every owner-specific notice route (native `NoticeOwner`). */
export interface NoticeOwnerIdentity {
  origin: string;
  ownerId: string;
  agentId: string;
}

/** The host's current connection as the notice fence sees it. */
export interface NoticeOwnerSnapshot {
  /** Stable identity of the current session ("" when there is none). */
  identity: string;
  owner: NoticeOwnerIdentity | null;
  hasSession: boolean;
  /** Initial session restoration finished (with or without a session). */
  startupResolved?: boolean;
  /** A reconnect is in progress; the session may be briefly absent. */
  busy?: boolean;
}

export interface NoticeOwnerOperations<T> {
  /** Persists the native fence: other owners' results withdrawn, their approvals suspended. */
  transition(snapshot: NoticeOwnerSnapshot): Promise<T>;
  /** The host's serialized notice work queue. */
  enqueue(work: () => Promise<void>): void;
  /** True while the snapshot's session is current and the host may read on its behalf. */
  available(snapshot: NoticeOwnerSnapshot): boolean;
  /** Read-only revalidation of the returning owner's suspended notices. */
  restore(
    result: T,
    snapshot: NoticeOwnerSnapshot,
    valid: () => boolean,
  ): Promise<void>;
}

/**
 * The native privacy fence starts immediately on every owner change; remote
 * revalidation stays in the notice work queue. Initial session restoration and
 * retry-needed are separate states, so a failed call never hides a sign-out.
 */
export class NoticeOwnerCoordinator<T> {
  private initialized = false;
  private identity = "";
  private retryNeeded = false;
  private generation = 0;
  private readonly operations: NoticeOwnerOperations<T>;

  constructor(operations: NoticeOwnerOperations<T>) {
    this.operations = operations;
  }

  update(snapshot: NoticeOwnerSnapshot): void {
    if (!this.initialized) {
      if (!snapshot.hasSession && !snapshot.startupResolved) return;
      this.initialized = true;
      this.retryNeeded = true;
    }
    // A reconnect retires the session while the connection is busy. Withdrawal
    // without an owner is terminal for result notices, so a null owner is
    // published only once the connection settles; a reconnect to the same owner
    // never withdraws them.
    if (!snapshot.hasSession && snapshot.busy) return;
    if (snapshot.identity === this.identity && !this.retryNeeded) return;
    this.identity = snapshot.identity;
    this.retryNeeded = false;
    const generation = ++this.generation;
    const transition = this.operations.transition(snapshot).then(
      (result) => ({ result, error: null as unknown }),
      (error: unknown) => ({ result: null as T | null, error }),
    );
    const valid = () =>
      generation === this.generation && this.operations.available(snapshot);
    const retry = () => {
      if (generation === this.generation) this.retryNeeded = true;
    };
    this.operations.enqueue(async () => {
      try {
        const completed = await transition;
        if (completed.error || completed.result === null)
          throw completed.error ?? new Error("Notice owner fence unavailable");
        if (generation !== this.generation || !snapshot.hasSession) return;
        if (!valid()) {
          retry();
          return;
        }
        await this.operations.restore(completed.result, snapshot, valid);
        if (!valid()) retry();
      } catch {
        retry();
      }
    });
  }
}

/** The excerpt of the host's own still-posted notice an Ask tap may show. */
export interface NoticeTapNotice {
  id: string;
  revision: string;
  source: string;
  appLabel: string;
  title: string;
  text: string;
}

/** A pending tap as the native route ledger reports it: route fields plus tap state. */
export interface PendingNoticeTap extends NoticeOwnerIdentity {
  scope: string;
  token: string;
  operationId: string;
  bindingHash: string;
  /** The notice's delivery receipt is still posted and its owner current. */
  retained: boolean;
  question?: boolean;
  notice?: NoticeTapNotice;
  [identifier: string]: unknown;
}

/** The connection a tap may open in. */
export interface NoticeTapBinding extends NoticeOwnerIdentity {
  scope: string;
  current(): boolean;
}

export type NoticeTapResolution<Target> =
  | { kind: "lookup-unavailable" }
  | { kind: "none" }
  | { kind: "other-account" }
  | { kind: "unavailable" }
  | {
      kind: "ready";
      token: string;
      target: Target;
      question: boolean;
      notice?: NoticeTapNotice;
    };

const ROUTE_OWNER_FIELDS = [
  "token",
  "operationId",
  "bindingHash",
  "scope",
  "origin",
  "ownerId",
  "agentId",
] as const;

/**
 * Opens a captured tap only through authenticated reads of its exact route.
 * `identifiers` name the host's route identities (for example workflowId, runId,
 * versionId); `load` performs the reads, calls `checkpoint()` after each one and
 * returns null when the target no longer matches the route. The durable tap is
 * read again before the result is exposed, so a tap that changed, was consumed
 * or lost its receipt during the reads is never opened.
 */
export async function resolveNoticeTap<Target>(input: {
  pending: () => Promise<Partial<PendingNoticeTap>>;
  binding: NoticeTapBinding | null;
  identifiers: readonly string[];
  load: (
    tap: PendingNoticeTap,
    signal: AbortSignal,
    checkpoint: () => void,
  ) => Promise<Target | null>;
  signal: AbortSignal;
}): Promise<NoticeTapResolution<Target>> {
  const { binding, identifiers, signal } = input;
  let tap: Partial<PendingNoticeTap>;
  try {
    tap = await input.pending();
  } catch {
    signal.throwIfAborted();
    return { kind: "lookup-unavailable" };
  }
  signal.throwIfAborted();
  if (!tap.token) return { kind: "none" };
  if (
    !binding?.current() ||
    tap.scope !== binding.scope ||
    tap.origin !== binding.origin ||
    tap.ownerId !== binding.ownerId ||
    tap.agentId !== binding.agentId
  )
    return { kind: "other-account" };
  if (
    tap.retained !== true ||
    identifiers.some((key) => typeof tap[key] !== "string")
  )
    return { kind: "unavailable" };
  const checkpoint = () => {
    signal.throwIfAborted();
    if (!binding.current()) throw new Error("Agent changed");
  };
  const target = await input.load(tap as PendingNoticeTap, signal, checkpoint);
  if (target === null) return { kind: "unavailable" };
  // Re-read the durable tap immediately before exposing the result.
  const latest = await input.pending();
  checkpoint();
  for (const key of [...ROUTE_OWNER_FIELDS, ...identifiers])
    if (latest[key] !== tap[key]) return { kind: "unavailable" };
  if (
    latest.question !== tap.question ||
    JSON.stringify(latest.notice) !== JSON.stringify(tap.notice) ||
    latest.retained !== true
  )
    return { kind: "unavailable" };
  return {
    kind: "ready",
    token: tap.token,
    target,
    question: tap.question === true,
    ...(tap.notice ? { notice: tap.notice } : {}),
  };
}

/** The exact run route of a workflow notice (native route fields of a workflow host). */
export interface WorkflowNoticeRoute extends NoticeOwnerIdentity {
  scope: string;
  workflowId: string;
  runId: string;
  versionId: string;
}

async function sha256Json(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * Opaque identity of one pending phone-step approval notice. The ID is stable per
 * approval (one notice per approval, whatever version it was posted under) and
 * reveals nothing about the step; the binding names the exact route, so a notice
 * whose route changed is refused natively. These derivations are installed
 * identities: changing them orphans notices already posted on phones.
 */
export async function workflowApprovalNoticeIdentity(
  route: WorkflowNoticeRoute,
  proposalId: string,
): Promise<{ id: string; bindingHash: string }> {
  if (typeof proposalId !== "string" || !proposalId || proposalId.length > 256)
    throw new Error("Invalid approval notice identity");
  return {
    id: `approval-${await sha256Json(["workflow-approval-notice", route.scope, route.runId, proposalId])}`,
    bindingHash: await sha256Json([
      "workflow-approval-route",
      route.scope,
      route.origin,
      route.ownerId,
      route.agentId,
      route.workflowId,
      route.runId,
      route.versionId,
      proposalId,
    ]),
  };
}

/** A suspended approval notice as the native fence returns it for its owner. */
export interface SuspendedApprovalNotice {
  id: string;
  bindingHash: string;
  expiresAt: number;
  route: WorkflowNoticeRoute;
}

/** Read-only views of the agent the revalidation needs; none of them decides or executes. */
export interface WorkflowApprovalNoticeReads<Run, Review> {
  detail(
    workflowId: string,
    signal: AbortSignal,
  ): Promise<{ versionId: string; removed?: boolean }>;
  receipt(
    runId: string,
    workflowId: string,
    signal: AbortSignal,
  ): Promise<Run & { versionId: string; finished: boolean }>;
  phoneReview(
    run: Run,
    signal: AbortSignal,
  ): Promise<
    Review & { finished: boolean; cancellationRequestedAt: string | null }
  >;
  /** The still-pending phone-step approvals of that review. */
  pending(
    review: Review,
    signal: AbortSignal,
  ): Promise<Array<{ id: string; expiresAt: number }>>;
}

/**
 * Decides whether a suspended approval notice may be reposted quietly for its
 * returning owner: only while the workflow version, the run, its phone review and
 * the exact pending approval (same binding and expiry) are all unchanged and
 * unexpired. Read-only: no approval context, source read, execution or provider
 * mutation. `stale` means the session changed during the reads.
 */
export async function revalidateWorkflowApprovalNotice<Run, Review>(
  notice: SuspendedApprovalNotice,
  reads: WorkflowApprovalNoticeReads<Run, Review>,
  valid: () => boolean,
  signal: AbortSignal,
  now: () => number = () => Date.now(),
): Promise<"resume" | "withdraw" | "stale"> {
  if (!valid()) return "stale";
  const route = notice.route;
  const current = await reads.detail(route.workflowId, signal);
  if (!valid()) return "stale";
  if (
    current.removed ||
    current.versionId !== route.versionId ||
    notice.expiresAt <= now()
  )
    return "withdraw";
  const run = await reads.receipt(route.runId, route.workflowId, signal);
  if (!valid()) return "stale";
  if (run.versionId !== route.versionId || run.finished) return "withdraw";
  const review = await reads.phoneReview(run, signal);
  if (!valid()) return "stale";
  if (review.finished || review.cancellationRequestedAt) return "withdraw";
  const pending = await reads.pending(review, signal);
  let matches = false;
  for (const step of pending) {
    const bound = await workflowApprovalNoticeIdentity(route, step.id);
    if (
      bound.id === notice.id &&
      bound.bindingHash === notice.bindingHash &&
      step.expiresAt === notice.expiresAt
    )
      matches = true;
  }
  if (!valid()) return "stale";
  return matches && notice.expiresAt > now() ? "resume" : "withdraw";
}
