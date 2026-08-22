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
  type AccountDeletionAvailability,
  endLocalSessionAfterDeletion,
  getAccountDeletionAvailability,
  submitAccountDeletion,
} from "../data/account-deletion-client";

function SupportLink({
  support,
}: {
  support: { email: string; href: string };
}) {
  return (
    <a className="underline" href={support.href}>
      {support.email}
    </a>
  );
}

export function AccountDeletionDialog({
  triggerLabel = "Delete account",
}: {
  triggerLabel?: string;
}) {
  const [availability, setAvailability] =
    useState<AccountDeletionAvailability | null>(null);
  const [availabilityError, setAvailabilityError] = useState<string | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    void getAccountDeletionAvailability()
      .then((projection) => {
        if (current) setAvailability(projection);
      })
      .catch((cause: unknown) => {
        // error-policy:J4 The read failure is rendered as an explicit unavailable state.
        if (current) {
          setAvailabilityError(
            cause instanceof Error
              ? cause.message
              : "Account deletion status could not be loaded",
          );
        }
      });
    return () => {
      current = false;
    };
  }, []);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const request = await submitAccountDeletion();
      setAvailability({
        status: "existing_receipt",
        request,
        support: null,
      });
      setOpen(false);
      await endLocalSessionAfterDeletion();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion could not be scheduled",
      );
      setSubmitting(false);
    }
  };

  if (availabilityError) {
    return (
      <p className="max-w-sm text-sm text-danger" role="alert">
        Account deletion status could not be loaded: {availabilityError}
      </p>
    );
  }

  if (!availability) {
    return (
      <p className="text-sm text-muted" role="status">
        Checking account deletion availability…
      </p>
    );
  }

  if (availability.status === "existing_receipt") {
    return (
      <div
        className="max-w-sm space-y-1 text-sm"
        data-testid="account-deletion-receipt"
      >
        <p className="font-medium text-success">Deletion request on file</p>
        <p className="text-muted-strong">
          Request <code>{availability.request.requestId}</code> is{" "}
          {availability.request.status}. Receipt target date:{" "}
          {availability.request.scheduledDeletionAt}.
        </p>
      </div>
    );
  }

  if (availability.status === "transfer_required") {
    return (
      <div
        className="max-w-sm space-y-1 text-sm"
        data-testid="account-deletion-transfer-required"
      >
        <p className="font-medium text-warning">Transfer required</p>
        <p className="text-muted-strong">
          Transfer or revoke shared organization resources before requesting
          deletion. Contact <SupportLink support={availability.support} /> for
          help.
        </p>
      </div>
    );
  }

  if (availability.status === "lifecycle_unavailable") {
    return (
      <div
        className="max-w-sm space-y-1 text-sm"
        data-testid="account-deletion-lifecycle-unavailable"
      >
        <p className="font-medium text-warning">
          Account deletion is currently unavailable
        </p>
        <p className="text-muted-strong">
          No deletion has been scheduled and your account remains active.
          Contact <SupportLink support={availability.support} /> for the safe
          support path.
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
              Submitting this request starts the server-managed deletion
              process. The returned receipt is the authority for its status; do
              not assume access is disabled until the service confirms it.
              Limited transaction, fraud, tax, or security records may be
              retained when legally required. This cannot be undone.
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
