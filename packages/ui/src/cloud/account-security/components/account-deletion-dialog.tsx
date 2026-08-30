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
import { TextLink } from "../../../components/ui/text-link";
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
  const [serverAccepted, setServerAccepted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    let accepted: Awaited<ReturnType<typeof submitAccountDeletion>>;
    try {
      accepted = await submitAccountDeletion();
      setServerAccepted(true);
    } catch (cause) {
      // error-policy:J4 request failure remains visibly distinct and leaves
      // the confirmation dialog open for a safe retry.
      setError(
        cause instanceof Error
          ? cause.message
          : "Deletion could not be scheduled",
      );
      setSubmitting(false);
      return;
    }

    try {
      await endLocalSessionAfterDeletion();
    } catch {
      // error-policy:J4 the server outcome is already committed. Keep the
      // destructive action disabled and expose the explicit cleanup route.
      setError(
        "Deletion is scheduled, but local sign-out is incomplete on this device.",
      );
    }
    onAccepted?.(accepted.request);
    if (!onAccepted && typeof window !== "undefined") {
      window.location.assign("/account-deletion");
    }
  };

  return (
    <>
      <Button
        size="sm"
        variant="dangerOutline"
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
              After this browser securely saves your recovery access, account
              access is disabled and your Steward identity and associated Eliza
              Cloud data enter a 30-day recovery window before irreversible
              deletion. You can download the export when it is ready or cancel
              from the account-deletion page during that window. Limited
              transaction, fraud, tax, or security records may be retained when
              legally required.
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
              {error}{" "}
              {serverAccepted ? (
                <TextLink href="/account-deletion">
                  Continue to deletion status
                </TextLink>
              ) : null}
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
              {serverAccepted
                ? "Deletion scheduled"
                : submitting
                  ? "Scheduling…"
                  : "Delete account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
