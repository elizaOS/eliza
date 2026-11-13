/** Renders the confirmation and status flow for permanent account-deletion requests. */

import type { AccountDeletionStatusDto } from "@elizaos/cloud-sdk/browser-contracts/account-lifecycle";
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
import { useSessionAuth } from "../../lib/use-session-auth";
import {
  AccountDeletionClientError,
  abandonAccountDeletion,
  endLocalSessionAfterDeletion,
  finishAccountDeletion,
  submitAccountDeletion,
} from "../data/account-deletion-client";
import { needsSignInAgain, signInAgainPath } from "../data/sign-in-again";

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
  const [signInAgain, setSignInAgain] = useState(false);
  // Set when the request was saved but its activation was not confirmed.
  const [pendingRequestId, setPendingRequestId] = useState<string | null>(null);
  const session = useSessionAuth();

  const submit = async () => {
    setSubmitting(true);
    setError(null);
    setSignInAgain(false);
    let request: AccountDeletionStatusDto;
    try {
      // A saved request whose activation failed is finished, not re-sent.
      request = pendingRequestId
        ? await finishAccountDeletion(pendingRequestId)
        : (
            await submitAccountDeletion(
              session.user
                ? { id: session.user.id, label: session.user.email || null }
                : null,
            )
          ).request;
      setPendingRequestId(null);
      setServerAccepted(true);
    } catch (cause) {
      // error-policy:J4 request failure remains visibly distinct and leaves
      // the confirmation dialog open for a safe retry.
      if (needsSignInAgain(cause)) {
        setSignInAgain(true);
        setSubmitting(false);
        return;
      }
      if (
        cause instanceof AccountDeletionClientError &&
        cause.code === "ACCOUNT_DELETION_ACTIVATION_PENDING"
      ) {
        setPendingRequestId(cause.requestId);
      }
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
    onAccepted?.(request);
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
              deletion. During that window you can cancel, or download an
              optional data export, from the account-deletion page. No export is
              made unless you start one. Limited transaction, fraud, tax, or
              security records may be retained when legally required.
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
          {signInAgain ? (
            <p
              className="text-sm text-danger"
              role="alert"
              data-testid="delete-account-sign-in-again"
            >
              <TextLink href={signInAgainPath()}>
                Sign in again to continue
              </TextLink>
            </p>
          ) : null}
          {error ? (
            <p className="text-sm text-danger" role="alert">
              {error}{" "}
              {serverAccepted || pendingRequestId ? (
                <TextLink href="/account-deletion">
                  Continue to deletion status
                </TextLink>
              ) : null}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel
              disabled={submitting}
              onClick={() => {
                if (!pendingRequestId) return;
                try {
                  abandonAccountDeletion(pendingRequestId);
                  setPendingRequestId(null);
                  setError(null);
                } catch {
                  // error-policy:J6 a request that stays saved is still shown
                  // on the account-deletion page with Finish and Keep options.
                }
              }}
            >
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
                  : pendingRequestId
                    ? "Finish deletion"
                    : "Delete account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
