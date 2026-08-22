/** Renders the confirmation and status flow for permanent account-deletion requests. */

import type { AccountDeletionStatusDto } from "@elizaos/cloud-shared/types/account-lifecycle";
import { useState } from "react";
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
  endLocalSessionAfterDeletion,
  submitAccountDeletion,
} from "../data/account-deletion-client";

export function AccountDeletionDialog({
  triggerLabel = "Delete account",
  onAccepted,
}: {
  triggerLabel?: string;
  onAccepted?: (request: AccountDeletionStatusDto) => void;
}) {
  const [open, setOpen] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const accepted = await submitAccountDeletion();
      await endLocalSessionAfterDeletion();
      onAccepted?.(accepted.request);
      if (!onAccepted && typeof window !== "undefined") {
        window.location.assign("/account-deletion");
      }
    } catch (cause) {
      // error-policy:J4 request failure remains visibly distinct and leaves
      // the confirmation dialog open for a safe retry.
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion could not be scheduled",
      );
      setSubmitting(false);
    }
  };

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
              Access is disabled immediately. Your Steward identity and
              associated Eliza Cloud data enter a 30-day recovery window before
              irreversible deletion. You can download the export when it is
              ready or cancel from the account-deletion page during that window.
              Limited transaction, fraud, tax, or security records may be
              retained when legally required.
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
