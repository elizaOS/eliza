/** Server-authoritative external request, status, export, and recovery page. */

import type { AccountDeletionStatusDto } from "@elizaos/cloud-sdk/browser-contracts/account-lifecycle";
import {
  CheckCircle2,
  CircleAlert,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { useBranding } from "../../../../config/branding-react.hooks";
import { downloadAttachment } from "../../../../utils/download-share";
import { AccountDeletionDialog } from "../../../account-security/components/account-deletion-dialog";
import {
  abandonAccountDeletion,
  cancelAccountDeletion,
  downloadAccountDeletionExport,
  finishAccountDeletion,
  readAccountDeletionStatuses,
  type StoredAccountDeletion,
} from "../../../account-security/data/account-deletion-client";
import { useDocumentTitle } from "../../../lib/use-document-title";
import { useSessionAuth } from "../../../lib/use-session-auth";

function statusHeading(request: AccountDeletionStatusDto): string {
  switch (request.status) {
    case "pending_activation":
      return "Deletion not finished";
    case "reserved":
      return "Deletion request reserved";
    case "recovery":
      return "Recovery window active";
    case "canceling":
      return "Cancellation cleanup in progress";
    case "scheduled":
    case "processing":
      return "Permanent deletion in progress";
    case "completed":
      return "Account deletion completed";
    case "canceled":
      return "Account deletion canceled";
    case "action_required":
      return "Deletion needs support review";
  }
}

function statusInstruction(request: AccountDeletionStatusDto): string {
  switch (request.status) {
    case "pending_activation":
      return "Your account is still active. Finish deletion to disable access and start the 30-day recovery window, or keep your account.";
    case "reserved":
      return "Account access is disabled. You can download your data or cancel before the recovery window expires.";
    case "recovery":
      return "Account access is disabled. Download the export or cancel before the recovery window expires.";
    case "canceling":
      return "Account access remains disabled until export cleanup and identity reactivation are durably complete.";
    case "scheduled":
    case "processing":
      return "The recovery window has ended and permanent deletion is being reconciled.";
    case "completed":
      return "The personal account and associated data have been permanently erased.";
    case "canceled":
      return "Cancellation cleanup is complete and account access has been restored.";
    case "action_required":
      return "Account access remains disabled. Contact support so the blocked deletion phase can be resolved safely.";
  }
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function DeletionRequestCard({
  entry,
  onChanged,
  onRemoved,
  onRefresh,
  onError,
}: {
  entry: StoredAccountDeletion;
  onChanged: (request: AccountDeletionStatusDto) => void;
  onRemoved: () => void;
  onRefresh: () => Promise<void>;
  onError: (message: string | null) => void;
}) {
  const { request } = entry;
  const [cancelConfirmation, setCancelConfirmation] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [exporting, setExporting] = useState(false);
  const [finishing, setFinishing] = useState(false);

  const finish = async () => {
    setFinishing(true);
    onError(null);
    try {
      onChanged(await finishAccountDeletion(request.requestId));
    } catch (cause) {
      // error-policy:J4 activation failure remains visible and retryable.
      onError(errorMessage(cause, "Deletion could not be finished"));
    } finally {
      setFinishing(false);
    }
  };

  const keep = () => {
    onError(null);
    try {
      abandonAccountDeletion(request.requestId);
      onRemoved();
    } catch (cause) {
      // error-policy:J4 a request that could not be forgotten stays listed.
      onError(errorMessage(cause, "The request could not be removed"));
    }
  };

  const cancel = async () => {
    setCanceling(true);
    onError(null);
    try {
      onChanged(await cancelAccountDeletion(request.requestId));
      setCancelConfirmation("");
    } catch (cause) {
      // error-policy:J4 cancellation failure remains visible and retryable.
      onError(errorMessage(cause, "Deletion could not be canceled"));
    } finally {
      setCanceling(false);
    }
  };

  const downloadExport = async () => {
    setExporting(true);
    onError(null);
    try {
      const download = await downloadAccountDeletionExport(request.requestId);
      const url = URL.createObjectURL(download.blob);
      try {
        await downloadAttachment(url, download.filename);
      } finally {
        URL.revokeObjectURL(url);
      }
      setExportConfirmation("");
      await onRefresh();
    } catch (cause) {
      // error-policy:J4 export failure remains visible and never presents a
      // download as successful.
      onError(errorMessage(cause, "Export could not be downloaded"));
    } finally {
      setExporting(false);
    }
  };

  return (
    <section
      className={`space-y-4 rounded-lg border bg-bg-elevated p-6 ${
        request.status === "action_required"
          ? "border-danger/40"
          : request.status === "completed" || request.status === "canceled"
            ? "border-success/40"
            : "border-border"
      }`}
      data-testid="account-deletion-request"
    >
      {request.status === "completed" || request.status === "canceled" ? (
        <CheckCircle2 className="h-7 w-7 text-success" />
      ) : request.status === "action_required" ? (
        <CircleAlert className="h-7 w-7 text-danger" />
      ) : (
        <RefreshCw className="h-7 w-7 text-accent" />
      )}
      <h2 className="text-xl font-semibold">{statusHeading(request)}</h2>
      <p className="text-sm text-muted-strong">
        Account: {entry.accountLabel ?? "saved in this browser"}
      </p>
      <p className="text-muted-strong">
        Request <code>{request.requestId}</code> is in server-authoritative
        state <strong>{request.status}</strong>.
      </p>
      <p className="text-muted-strong">{statusInstruction(request)}</p>
      {request.status === "pending_activation" ? (
        <div className="flex flex-wrap gap-3 border-t border-border pt-4">
          <Button
            variant="destructive"
            disabled={finishing}
            onClick={() => void finish()}
          >
            {finishing ? "Finishing…" : "Finish deletion"}
          </Button>
          <Button variant="outline" disabled={finishing} onClick={keep}>
            Keep my account
          </Button>
        </div>
      ) : null}
      {request.recoveryExpiresAt ? (
        <p className="text-sm text-muted-strong">
          Recovery is available through{" "}
          <time dateTime={request.recoveryExpiresAt}>
            {request.recoveryExpiresAt}
          </time>
          . After that boundary, provider cleanup and erasure are irreversible.
        </p>
      ) : null}
      {request.export ? (
        <p className="text-sm text-muted-strong">
          Export status: <strong>{request.export.status}</strong>
          {request.export.contentDigest
            ? ` · SHA-256 ${request.export.contentDigest}`
            : ""}
        </p>
      ) : null}
      {request.canCancel ? (
        <div className="space-y-3 border-t border-border pt-4">
          <label
            className="block space-y-2 text-sm"
            htmlFor={`export-deletion-confirmation-${request.requestId}`}
          >
            <span>Type EXPORT MY DATA to build and download the archive</span>
            <Input
              id={`export-deletion-confirmation-${request.requestId}`}
              value={exportConfirmation}
              onChange={(event) => setExportConfirmation(event.target.value)}
              autoComplete="off"
              disabled={exporting}
            />
          </label>
          <Button
            variant="outline"
            disabled={exportConfirmation !== "EXPORT MY DATA" || exporting}
            onClick={() => void downloadExport()}
          >
            {exporting ? "Preparing export…" : "Download my data"}
          </Button>
        </div>
      ) : null}
      {request.canCancel ? (
        <div className="space-y-3 border-t border-border pt-4">
          <label
            className="block space-y-2 text-sm"
            htmlFor={`cancel-deletion-confirmation-${request.requestId}`}
          >
            <span>Type CANCEL DELETION to begin restoring account access</span>
            <Input
              id={`cancel-deletion-confirmation-${request.requestId}`}
              value={cancelConfirmation}
              onChange={(event) => setCancelConfirmation(event.target.value)}
              autoComplete="off"
              disabled={canceling}
            />
          </label>
          <Button
            variant="outline"
            disabled={cancelConfirmation !== "CANCEL DELETION" || canceling}
            onClick={() => void cancel()}
          >
            {canceling ? "Canceling deletion…" : "Cancel account deletion"}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

export default function AccountDeletionPage() {
  const branding = useBranding();
  const cloudName = branding.cloudName || `${branding.appName} Cloud`;
  const supportEmail = branding.supportEmail?.trim();
  useDocumentTitle(`Delete your ${branding.appName} account | ${cloudName}`);
  const session = useSessionAuth();
  const [entries, setEntries] = useState<StoredAccountDeletion[]>([]);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setEntries(await readAccountDeletionStatuses());
    } catch (cause) {
      // error-policy:J4 status failure remains visibly distinct from an empty
      // or completed deletion state.
      setStatusError(errorMessage(cause, "Deletion status is unavailable"));
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const replaceRequest = (request: AccountDeletionStatusDto) => {
    setEntries((current) =>
      current.map((entry) =>
        entry.request.requestId === request.requestId
          ? { ...entry, request }
          : entry,
      ),
    );
  };

  const removeRequest = (requestId: string) => {
    setEntries((current) =>
      current.filter((entry) => entry.request.requestId !== requestId),
    );
  };

  // Requests saved by other accounts on this browser are listed with their
  // account so they are never mistaken for the visitor's own, and a signed-in
  // account without an open request of its own can still start one.
  const hasOwnOpenRequest = entries.some(
    (entry) =>
      session.user !== null &&
      entry.accountId === session.user.id &&
      entry.request.status !== "canceled",
  );
  const showSubmit =
    entries.length === 0 || (session.authenticated && !hasOwnOpenRequest);

  return (
    <div
      className="theme-cloud h-[100dvh] overflow-y-auto bg-bg px-6 py-16 font-sans text-txt sm:px-8"
      data-scroll-cert-scroller
    >
      <main className="mx-auto max-w-3xl space-y-8">
        <div className="space-y-3 border-b border-border pb-6">
          <p className="text-sm font-medium text-accent">
            {cloudName} account deletion
          </p>
          <h1 className="text-4xl font-bold tracking-tight">
            Delete your account and data
          </h1>
          <p className="leading-relaxed text-muted-strong">
            This is the external deletion-request and recovery path for the{" "}
            {branding.appName} app and {cloudName}. Status is accepted only from
            the opaque capability issued by the server, never from a URL
            parameter.
          </p>
        </div>

        {entries.map((entry) => (
          <DeletionRequestCard
            key={entry.request.requestId}
            entry={entry}
            onChanged={replaceRequest}
            onRemoved={() => removeRequest(entry.request.requestId)}
            onRefresh={refreshStatus}
            onError={setStatusError}
          />
        ))}

        {entries.length > 0 ? (
          <Button
            variant="ghost"
            onClick={() => void refreshStatus()}
            disabled={statusLoading}
          >
            <RefreshCw className="mr-2 h-4 w-4" />
            {statusLoading ? "Refreshing…" : "Refresh server status"}
          </Button>
        ) : null}

        {showSubmit ? (
          <section className="space-y-5 rounded-lg border border-border bg-bg-elevated p-6">
            <ShieldCheck className="h-7 w-7 text-accent" />
            <h2 className="text-xl font-semibold">Submit a verified request</h2>
            <p className="text-muted-strong">
              Sign in to verify ownership, then confirm deletion. Access and new
              paid/provider work are fenced immediately. A 30-day recovery
              window applies before permanent deletion begins.
            </p>
            {statusLoading ? (
              <p className="text-sm text-muted">Checking deletion status…</p>
            ) : !session.ready ? (
              <p className="text-sm text-muted">Checking your session…</p>
            ) : session.authenticated ? (
              <AccountDeletionDialog onAccepted={() => void refreshStatus()} />
            ) : (
              <Button asChild>
                <Link to="/login?returnTo=%2Faccount-deletion">
                  Sign in to request deletion
                </Link>
              </Button>
            )}
          </section>
        ) : null}

        {statusError ? (
          <p className="text-sm text-danger" role="alert">
            {statusError}
          </p>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-xl font-semibold">What is deleted</h2>
          <p className="leading-relaxed text-muted-strong">
            Your login identity, profile, sessions, API keys, personal
            conversations, agents, connectors, provider credentials, files,
            media, backups, and resources associated only with your personal
            account are reconciled and deleted. Shared organization content is
            preserved and requires explicit successor ownership or revocation.
          </p>
          <p className="leading-relaxed text-muted-strong">
            Billing, transaction, tax, fraud-prevention, security, or legal
            evidence may be retained only when required. Direct account
            identifiers are removed or replaced with a bounded non-identifying
            audit receipt, and retained records expire under their applicable
            legal schedule.
          </p>
        </section>

        <section className="space-y-3 border-t border-border pt-6">
          <h2 className="text-xl font-semibold">Cannot sign in?</h2>
          {supportEmail ? (
            <p className="text-muted-strong">
              Email{" "}
              <a
                className="underline"
                href={`mailto:${encodeURIComponent(supportEmail)}?subject=${encodeURIComponent(`${branding.appName} account deletion request`)}`}
              >
                {supportEmail}
              </a>{" "}
              from the address on your account. Include only your account email
              and the words “account deletion request.” Never send a password,
              API key, status capability, recovery capability, or wallet secret.
            </p>
          ) : (
            <p className="text-muted-strong">
              Support contact details are unavailable. Contact the service
              operator through your usual support channel.
            </p>
          )}
          <div className="flex gap-4 text-sm">
            <Link className="underline" to="/privacy-policy">
              Privacy Policy
            </Link>
            <Link className="underline" to="/terms-of-service">
              Terms of Service
            </Link>
          </div>
        </section>
      </main>
    </div>
  );
}
