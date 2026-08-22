/** Renders the confirmation and status flow for permanent account-deletion requests. */

import { useEffect, useState } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../../components/ui/alert-dialog";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import {
  type AccountDeletionStatusDto,
  endLocalSessionAfterDeletion,
  getAccountDeletionStatus,
  submitAccountDeletion,
} from "../data/account-deletion-client";

const SUPPORT_HREF =
  "mailto:support@eliza.cloud?subject=Eliza%20account%20deletion%20request";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; status: AccountDeletionStatusDto };

export function AccountDeletionDialog({
  triggerLabel = "Delete account",
}: {
  triggerLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void getAccountDeletionStatus()
      .then((status) => {
        if (active) setLoadState({ kind: "ready", status });
      })
      .catch((cause: unknown) => {
        // error-policy:J4 A failed status read leaves deletion visibly unavailable.
        if (active) {
          setLoadState({
            kind: "error",
            message:
              cause instanceof Error
                ? cause.message
                : "Account deletion status is unavailable",
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await submitAccountDeletion();
      await endLocalSessionAfterDeletion();
      if (typeof window !== "undefined") {
        window.location.assign("/account-deletion");
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion could not be scheduled",
      );
      setSubmitting(false);
    }
  };

  if (loadState.kind === "loading") {
    return (
      <Button
        size="sm"
        variant="outline"
        disabled
        data-testid="delete-account-trigger"
      >
        Checking deletion status…
      </Button>
    );
  }

  if (loadState.kind === "error") {
    return (
      <div className="space-y-2 text-right">
        <Button
          size="sm"
          variant="outline"
          disabled
          data-testid="delete-account-trigger"
        >
          Status unavailable
        </Button>
        <p className="ml-auto max-w-sm text-sm text-danger" role="alert">
          {loadState.message}{" "}
          <a className="underline" href={SUPPORT_HREF}>
            Contact support
          </a>
          .
        </p>
      </div>
    );
  }

  const { status } = loadState;
  if (status.state !== "available") {
    const message =
      status.state === "transfer_required"
        ? "Transfer or revoke shared organization resources before requesting deletion."
        : status.state === "existing_request"
          ? `A prior deletion request needs support. Reference ${status.request.requestId}.`
          : "Self-service deletion is not currently available.";
    return (
      <div className="space-y-2 text-right">
        <Button
          size="sm"
          variant="outline"
          disabled
          className="border-danger/40 text-danger"
          data-testid="delete-account-trigger"
        >
          {status.state === "transfer_required"
            ? "Transfer required"
            : status.state === "existing_request"
              ? "Request needs support"
              : "Deletion unavailable"}
        </Button>
        <p className="ml-auto max-w-sm text-sm text-muted-strong" role="status">
          {message}{" "}
          <a className="underline" href={SUPPORT_HREF}>
            Contact support
          </a>
          .
        </p>
      </div>
    );
  }

  return (
    <>
      <Button
        size="sm"
        variant="outline"
        className="border-danger/40 text-danger"
        data-testid="delete-account-trigger"
        onClick={() => setOpen(true)}
      >
        {triggerLabel}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Permanently delete your Eliza account?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This permanently retires your account through the verified
              lifecycle shown by the server. Limited transaction, fraud, tax, or
              security records may be retained when legally required. This
              cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label
            className="space-y-2 text-sm text-txt"
            htmlFor="delete-account-confirmation"
          >
            Type DELETE to confirm
            <Input
              id="delete-account-confirmation"
              value={confirmation}
              onChange={(event) => setConfirmation(event.target.value)}
              autoComplete="off"
              disabled={submitting}
            />
          </label>
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>
              Keep account
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={confirmation !== "DELETE" || submitting}
              onClick={() => void submit()}
              data-testid="delete-account-confirm"
            >
              {submitting ? "Scheduling…" : "Delete account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
