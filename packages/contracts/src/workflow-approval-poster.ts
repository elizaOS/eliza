import {
  type WorkflowNoticeRoute,
  workflowApprovalNoticeIdentity as workflowApprovalNotice,
} from "./notice-routes.ts";

interface ApprovalRun {
  workflowId: string;
  finished: boolean;
}
interface ApprovalReview {
  finished: boolean;
  cancellationRequestedAt?: unknown;
}
export interface ApprovalPosterSession<
  Run extends ApprovalRun,
  Review extends ApprovalReview,
> {
  identity: string;
  current(): boolean;
  route(run: Run): WorkflowNoticeRoute;
  list(signal: AbortSignal): Promise<Array<{ id: string }>>;
  executions(id: string, signal: AbortSignal): Promise<Run[]>;
  phoneReview(run: Run, signal: AbortSignal): Promise<Review>;
  pending(
    review: Review,
    signal: AbortSignal,
  ): Promise<Array<{ id: string; expiresAt: number }>>;
}
export interface ApprovalPosterNative {
  postWorkflowApprovalNotice(input: {
    id: string;
    bindingHash: string;
    expiresAt: number;
    route: WorkflowNoticeRoute;
  }): Promise<{ status: string }>;
  withdrawWorkflowApprovalNotice(input: { id: string }): Promise<void>;
}
/** Only the endpoint's explicit missing-resource status proves an old notice cannot resolve. */
export function definiteNoticeFailure(error: unknown): boolean {
  return (error as { status?: unknown })?.status === 404;
}
/**
 * Finds phone steps waiting for approval in any run (owner-, schedule- or agent-started) and posts one redacted
 * notice per step through the same identity and native ledger as an open receipt. A tap still opens the exact run,
 * where the step is reviewed. Notices whose step is no longer pending are withdrawn; a failed withdrawal is retried.
 * Runs only while Alpha's process does: a killed process posts nothing.
 */
export function createWorkflowApprovalPoster<
  Run extends ApprovalRun,
  Review extends ApprovalReview,
>(options: {
  session: () => ApprovalPosterSession<Run, Review> | null;
  native: () => ApprovalPosterNative;
  enqueue: (work: () => Promise<void>) => void;
  changed: () => void;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  /** Notices this process posted or saw posted, by notice id. */
  const posted = new Map<string, { identity: string; workflowId: string }>();
  let waiting = new Set<string>(),
    waitingIdentity = "",
    running: Promise<void> | null = null,
    again = false,
    last = { identity: "", at: -Infinity };
  const remember = (id: string, identity: string, workflowId: string) => {
    posted.set(id, { identity, workflowId });
  };
  const forget = (id: string) => {
    posted.delete(id);
  };
  async function sweep(session: ApprovalPosterSession<Run, Review>) {
    const signal = new AbortController().signal,
      found: Array<{
        route: WorkflowNoticeRoute;
        id: string;
        bindingHash: string;
        expiresAt: number;
      }> = [],
      unread = new Set<string>(),
      nextWaiting = new Set<string>();
    const flows = await session.list(signal);
    if (!session.current()) return;
    // A current definition can lose its phone steps while an older immutable version still waits.
    // Recheck known notices even if their workflow no longer appears in the current list.
    const workflowIds = new Set(flows.map((flow) => flow.id));
    for (const notice of posted.values())
      if (notice.identity === session.identity)
        workflowIds.add(notice.workflowId);
    for (const workflowId of workflowIds) {
      try {
        for (const run of await session.executions(workflowId, signal)) {
          if (!session.current()) return;
          // Every unfinished run is read, not only those labelled waiting-approval, so a notice an open receipt posted
          // is never withdrawn while its step is still pending.
          if (run.finished) continue;
          const review = await session.phoneReview(run, signal);
          if (!session.current()) return;
          if (review.finished || review.cancellationRequestedAt) continue;
          const route = session.route(run);
          for (const step of await session.pending(review, signal)) {
            if (!(step.expiresAt > now())) continue;
            const { id, bindingHash } = await workflowApprovalNotice(
              route,
              step.id,
            );
            found.push({ route, id, bindingHash, expiresAt: step.expiresAt });
            nextWaiting.add(workflowId);
          }
        }
      } catch (error) {
        if (!session.current()) return;
        if (!definiteNoticeFailure(error)) unread.add(workflowId);
      }
    }
    if (!session.current()) return;
    // A workflow that could not be read keeps its last state, as its notices do.
    if (waitingIdentity === session.identity)
      for (const id of unread) if (waiting.has(id)) nextWaiting.add(id);
    waiting = nextWaiting;
    waitingIdentity = session.identity;
    options.changed();
    const stale = [...posted]
      .filter(
        ([id, notice]) =>
          notice.identity === session.identity &&
          !found.some((entry) => entry.id === id) &&
          !unread.has(notice.workflowId),
      )
      .map(([id]) => id);
    // Another owner's notices are fenced natively (NoticeOwnerCoordinator); this process stops tracking them.
    for (const [id, notice] of posted)
      if (notice.identity !== session.identity) posted.delete(id);
    await new Promise<void>((resolve) =>
      options.enqueue(async () => {
        try {
          if (!session.current()) return;
          const native = options.native();
          for (const id of stale) {
            if (!session.current()) return;
            try {
              await native.withdrawWorkflowApprovalNotice({ id });
              if (!session.current()) return;
              posted.delete(id);
            } catch {
              /* Retried on the next sweep; it also expires with the approval. */
            }
          }
          for (const entry of found) {
            if (!session.current()) return;
            try {
              await native.postWorkflowApprovalNotice(entry);
              if (!session.current()) return;
              remember(entry.id, session.identity, entry.route.workflowId);
            } catch {
              /* The step stays waiting in Workflows. */
            }
          }
        } finally {
          resolve();
        }
      }),
    );
  }
  /** Connection updates can arrive in bursts; a sweep for the same session at most every 5 s unless forced. */
  const poll = (force = false): Promise<void> => {
    if (running) {
      again = true;
      return running;
    }
    const session = options.session();
    if (!session) return Promise.resolve();
    if (!force && last.identity === session.identity && now() - last.at < 5_000)
      return Promise.resolve();
    last = { identity: session.identity, at: now() };
    running = sweep(session)
      .catch(() => {
        /* Retried on the next tick. */
      })
      .finally(() => {
        running = null;
        if (again) {
          again = false;
          void poll(true);
        }
      });
    return running;
  };
  return {
    poll,
    remember,
    forget,
    /** True when the last sweep for this session found a phone step waiting for the owner. */
    waiting: (identity: string | undefined, workflowId: string) =>
      !!identity && identity === waitingIdentity && waiting.has(workflowId),
  };
}
