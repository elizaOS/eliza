/**
 * Icon-first home widget surfacing the oldest pending approval the user still
 * owes the agent (waiting longest = most overdue), tapping prefills the chat to
 * resolve it. One of the home-attention widget family; `useApprovals` reads the
 * shared pending-actions source and the widget publishes into the home-attention
 * store to rank itself on the home surface.
 */
import type { PendingUserAction } from "@elizaos/core";
import { CircleHelp } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { client } from "../../../api";
import { supportsFullAppShellRoutes } from "../../../api/app-shell-capabilities";
import { dispatchChatPrefill } from "../../../events";
import { useIntervalWhenDocumentVisible } from "../../../hooks";
import { useIsAuthenticated } from "../../../hooks/useAuthStatus";
import { useNow } from "../../../hooks/useNow";
import { usePublishHomeAttention } from "../../../widgets/home-attention-store";
import { HOME_SIGNAL_WEIGHTS } from "../../../widgets/home-priority";
import type { WidgetProps } from "../../../widgets/types";
import { HomeWidgetCard } from "./home-widget-card";

// The canonical "actions requiring your response" home card (#9449 PILLAR C):
// the ONE oldest decision the agent is blocked waiting on you for, with a badge
// of how many are pending. Data source is GET /api/approvals (served by the
// agent's approval-routes), which already projects the ApprovalService tasks
// into PendingUserAction[] — so this card only renders, no business logic.
//
// Renders null when nothing is pending, and self-publishes a home-attention
// signal so it floats up: `approval` weight while pending items exist, escalated
// to `escalation` weight once the oldest one has been waiting longer than the
// stale threshold (a decision left unanswered is more urgent over time).

const NEEDS_ATTENTION_WIDGET_KEY = "needs-attention/needs-attention.pending";
const REFRESH_INTERVAL_MS = 20_000;
/** A pending decision older than this escalates above the standard approval rank. */
export const STALE_PENDING_AGE_MS = 30 * 60_000; // 30 min

/** Shallow content equality so an unchanged poll doesn't re-render. */
function pendingEqual(
  a: readonly PendingUserAction[],
  b: readonly PendingUserAction[],
): boolean {
  if (a.length !== b.length) return false;
  return a.every((item, i) => {
    const other = b[i];
    return (
      item.id === other.id &&
      item.title === other.title &&
      item.createdAt === other.createdAt
    );
  });
}

/**
 * Poll the canonical pending-actions surface. Returns the live list plus a
 * `loaded` flag so the widget can stay invisible until the first fetch resolves
 * (the home surface must not flash an empty placeholder).
 */
export function useApprovals(): {
  pending: PendingUserAction[];
  loaded: boolean;
} {
  const [pending, setPending] = useState<PendingUserAction[]>([]);
  const [loaded, setLoaded] = useState(false);
  const mountedRef = useRef(true);
  // Auth gate (#11084): the widget mounts before the auth probe resolves, so
  // the 20s approvals poll must stay dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();

  const load = useCallback(async () => {
    if (!authenticated || !supportsFullAppShellRoutes(client.getBaseUrl())) {
      if (mountedRef.current) {
        setPending([]);
        setLoaded(true);
      }
      return;
    }
    try {
      const { pending: next } = await client.listPendingActions();
      if (!mountedRef.current) return;
      setPending((prev) => (pendingEqual(prev, next) ? prev : next));
    } catch {
      // error-policy:J4 glance tile — keep the last good data on a transient
      // fetch failure; the next tick refreshes.
    } finally {
      if (mountedRef.current) {
        setLoaded(true);
      }
    }
  }, [authenticated]);

  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);
  useIntervalWhenDocumentVisible(() => void load(), REFRESH_INTERVAL_MS);

  return { pending, loaded };
}

/**
 * The single high-priority datum: the OLDEST pending action (waiting longest =
 * most overdue). Computed once per snapshot so an unchanged poll keeps a stable
 * reference.
 */
function oldestPending(
  pending: readonly PendingUserAction[],
): PendingUserAction | null {
  if (pending.length === 0) return null;
  return pending.reduce((oldest, item) =>
    item.createdAt < oldest.createdAt ? item : oldest,
  );
}

export function NeedsAttentionWidget({
  spanClassName = "col-span-2 row-span-1",
}: Partial<WidgetProps>) {
  const { pending, loaded } = useApprovals();

  // `useNow` is 0 on the first render (deterministic render path — no Date.now
  // in render) then the live clock, ticking on the poll cadence to re-evaluate
  // the stale-age escalation. On the first render `now === 0` reads as not-stale
  // (the neutral `approval` weight); the live clock promotes it if overdue.
  const now = useNow(REFRESH_INTERVAL_MS);
  const top = useMemo(() => oldestPending(pending), [pending]);

  // Float up at `approval` weight while anything is pending; escalate to
  // `escalation` weight once the oldest decision has been waiting past the stale
  // threshold (age is read at render — the home ranker stamps `now`, so the
  // store holds the steady-state weight, not a clock value).
  const weight = useMemo(() => {
    if (top == null) return null;
    const stale = now - top.createdAt >= STALE_PENDING_AGE_MS;
    return stale
      ? HOME_SIGNAL_WEIGHTS.escalation
      : HOME_SIGNAL_WEIGHTS.approval;
  }, [top, now]);
  usePublishHomeAttention(NEEDS_ATTENTION_WIDGET_KEY, weight);

  // Route back to the handler: prefill the chat composer with a natural-language
  // approval so the agent's RESOLVE_REQUEST action resolves it in the same room
  // the request lives in. The widget never resolves the decision itself — it
  // hands the user to the canonical action.
  const onActivate = useCallback(() => {
    if (top == null) return;
    dispatchChatPrefill({ text: `Approve: ${top.title}`, select: true });
  }, [top]);

  // Render nothing until the first load resolves with pending items (#9143).
  if (!loaded || top == null) return null;

  const count = pending.length;
  const stale = now - top.createdAt >= STALE_PENDING_AGE_MS;
  return (
    <div className={`min-w-0 ${spanClassName}`}>
      <HomeWidgetCard
        icon={<CircleHelp />}
        label="Needs response"
        value={top.title}
        badge={count}
        tone={stale ? "warn" : "default"}
        testId="chat-widget-needs-attention"
        ariaLabel={`${count} action${count === 1 ? "" : "s"} need your response, oldest: ${top.title}. Respond in chat.`}
        onActivate={onActivate}
      />
    </div>
  );
}

export const NEEDS_ATTENTION_HOME_WIDGET = {
  pluginId: "needs-attention",
  id: "needs-attention.pending",
  order: 60,
  signalKinds: ["approval", "escalation"],
  Component: NeedsAttentionWidget,
} as const;
