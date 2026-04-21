import { Badge, Button } from "@elizaos/app-core";
import { useCallback, useEffect, useState } from "react";
import type {
  ApprovalRequest,
  ApprovalRequestState,
} from "../lifeops/approval-queue.types.js";

/**
 * Minimal approvals list view. Fetches pending approval queue entries and
 * exposes accept / reject buttons per row. Display-only — all computation
 * happens server-side in the queue service (Commandment 3).
 *
 * Expected server contract (wired up in WS5):
 *   GET  /api/lifeops/approvals       → ApprovalRequest[]
 *   POST /api/lifeops/approvals/:id/approve { reason: string }
 *   POST /api/lifeops/approvals/:id/reject  { reason: string }
 */

interface ApprovalsPanelProps {
  readonly subjectUserId: string;
  readonly apiBase: string;
}

interface FetchState {
  readonly loading: boolean;
  readonly error: string | null;
  readonly requests: ReadonlyArray<ApprovalRequest>;
}

const STATE_BADGE_TONE: Record<
  ApprovalRequestState,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "default",
  approved: "secondary",
  executing: "secondary",
  done: "outline",
  rejected: "destructive",
  expired: "outline",
};

async function postResolution(
  apiBase: string,
  id: string,
  intent: "approve" | "reject",
  reason: string,
): Promise<void> {
  const response = await fetch(`${apiBase}/api/lifeops/approvals/${id}/${intent}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `[ApprovalsPanel] ${intent} failed (${response.status}): ${body}`,
    );
  }
}

export function ApprovalsPanel({
  subjectUserId,
  apiBase,
}: ApprovalsPanelProps): JSX.Element {
  const [state, setState] = useState<FetchState>({
    loading: true,
    error: null,
    requests: [],
  });
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    const url = `${apiBase}/api/lifeops/approvals?subjectUserId=${encodeURIComponent(subjectUserId)}`;
    const response = await fetch(url);
    if (!response.ok) {
      const body = await response.text();
      setState({
        loading: false,
        error: `load failed (${response.status}): ${body}`,
        requests: [],
      });
      return;
    }
    const payload = (await response.json()) as {
      requests: ReadonlyArray<ApprovalRequest>;
    };
    setState({ loading: false, error: null, requests: payload.requests });
  }, [apiBase, subjectUserId]);

  useEffect(() => {
    void load();
  }, [load]);

  const resolve = useCallback(
    async (id: string, intent: "approve" | "reject") => {
      setBusyId(id);
      const reason = intent === "approve" ? "user approved" : "user rejected";
      await postResolution(apiBase, id, intent, reason);
      setBusyId(null);
      await load();
    },
    [apiBase, load],
  );

  if (state.loading) {
    return <div className="p-4 text-sm">Loading approval queue…</div>;
  }
  if (state.error !== null) {
    return (
      <div className="p-4 text-sm text-red-600">
        Failed to load approvals: {state.error}
      </div>
    );
  }
  if (state.requests.length === 0) {
    return (
      <div className="flex flex-col gap-2 p-4">
        <h2 className="text-lg font-semibold">Pending approvals</h2>
        <p className="text-sm text-muted-foreground">
          Nothing needs your approval right now. When the agent is about to take
          an action that requires your sign-off, it will show up here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 p-4">
      <div>
        <h2 className="text-lg font-semibold">Pending approvals</h2>
        <p className="text-xs text-muted-foreground">
          The agent is waiting for you before it runs these actions.
        </p>
      </div>
      <ul className="flex flex-col gap-2">
        {state.requests.map((request) => (
          <li
            key={request.id}
            className="flex flex-col gap-2 rounded-md border p-3"
          >
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant={STATE_BADGE_TONE[request.state]}>
                  {request.state}
                </Badge>
                <span className="font-medium">{request.action}</span>
                <span className="text-xs text-muted-foreground">
                  via {request.channel}
                </span>
              </div>
              <span className="text-xs text-muted-foreground">
                {request.createdAt.toLocaleString()}
              </span>
            </div>
            <p className="text-sm">{request.reason}</p>
            <details className="text-xs">
              <summary className="cursor-pointer text-muted-foreground">
                Show technical details
              </summary>
              <pre className="mt-2 max-h-32 overflow-auto rounded bg-muted p-2">
                {JSON.stringify(request.payload, null, 2)}
              </pre>
            </details>
            {request.state === "pending" && (
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busyId === request.id}
                  onClick={() => {
                    void resolve(request.id, "approve");
                  }}
                >
                  {busyId === request.id ? "Approving…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busyId === request.id}
                  onClick={() => {
                    void resolve(request.id, "reject");
                  }}
                >
                  {busyId === request.id ? "Rejecting…" : "Reject"}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
