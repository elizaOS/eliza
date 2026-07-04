/**
 * Sensitive tab: look up one sensitive request by id and cancel it.
 *
 * Unlike Approvals / Ballots, the backend exposes no owner *collection* endpoint
 * for sensitive requests — only POST-create, per-id GET, and cancel. So this tab
 * is a per-id lookup: the owner arrives with (or pastes) a request id and can
 * cancel a still-pending request. The recipient actually *submits* the value on
 * the public token page (or, for owner_app_inline secrets, on the inline chat
 * block) — this pane does not collect secrets. Adding a list endpoint is backend
 * work tracked as a follow-up.
 */

import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  Input,
} from "@elizaos/ui/components/primitives";
import { Loader2, LockKeyhole, Search } from "lucide-react";
import { type FormEvent, useCallback, useState } from "react";
import {
  formatApprovalTimestamp,
  useCancelSensitiveRequest,
  useSensitiveRequest,
} from "../lib/approvals";
import { StatusBadge } from "./status-badge";

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

export function SensitiveTab() {
  const [pendingId, setPendingId] = useState("");
  const [lookupId, setLookupId] = useState<string | null>(null);
  const query = useSensitiveRequest(lookupId);
  const cancel = useCancelSensitiveRequest();
  const [cancelError, setCancelError] = useState<string | null>(null);

  const handleLookup = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      setCancelError(null);
      setLookupId(pendingId.trim() || null);
    },
    [pendingId],
  );

  const request = query.data ?? null;

  const handleCancel = useCallback(async () => {
    if (!request) return;
    setCancelError(null);
    try {
      await cancel.mutateAsync({ id: request.id });
    } catch (caught) {
      setCancelError(errorMessage(caught, "Failed to cancel request."));
    }
  }, [cancel, request]);

  const expiresAt = request?.expiresAt
    ? formatApprovalTimestamp(request.expiresAt)
    : null;

  return (
    <div className="space-y-4">
      <form className="flex gap-2" onSubmit={handleLookup}>
        <Input
          value={pendingId}
          onChange={(event) => setPendingId(event.target.value)}
          placeholder="Sensitive request id"
          autoComplete="off"
          spellCheck={false}
          className="font-mono text-xs"
        />
        <Button type="submit" disabled={!pendingId.trim()}>
          <Search className="h-4 w-4" />
          Look up
        </Button>
      </form>

      {lookupId && query.isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted" />
        </div>
      ) : null}

      {lookupId && query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>Request not found</AlertTitle>
          <AlertDescription>
            {errorMessage(
              query.error,
              "No sensitive request with that id is visible to you.",
            )}
          </AlertDescription>
        </Alert>
      ) : null}

      {request ? (
        <div className="rounded-md border border-border bg-card p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="flex items-center gap-2">
              <LockKeyhole className="h-5 w-5 text-accent" />
              <div>
                <p className="text-sm font-medium text-txt">
                  {request.target?.key ?? request.kind}
                </p>
                <p className="text-xs text-muted">
                  {request.kind}
                  {expiresAt ? ` · expires ${expiresAt}` : ""}
                </p>
              </div>
            </div>
            <StatusBadge status={request.status} />
          </div>

          {request.reason ? (
            <p className="mt-3 text-sm text-muted-strong">{request.reason}</p>
          ) : null}

          {cancelError ? (
            <Alert className="mt-3" variant="destructive">
              <AlertTitle>Cancel failed</AlertTitle>
              <AlertDescription>{cancelError}</AlertDescription>
            </Alert>
          ) : null}

          {request.status === "pending" ? (
            <div className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => void handleCancel()}
                disabled={cancel.isPending}
              >
                {cancel.isPending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : null}
                Cancel request
              </Button>
              <p className="mt-2 text-xs text-muted">
                The recipient submits the value on the secure link sent to them.
              </p>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
