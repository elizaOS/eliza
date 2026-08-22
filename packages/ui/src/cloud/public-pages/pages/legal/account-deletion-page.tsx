/** Server-authoritative external request, status, export, and recovery page. */

import type { AccountDeletionStatusDto } from "@elizaos/cloud-shared/types/account-lifecycle";
import { CheckCircle2, RefreshCw, ShieldCheck } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "../../../../components/ui/button";
import { Input } from "../../../../components/ui/input";
import { downloadAttachment } from "../../../../utils/download-share";
import { AccountDeletionDialog } from "../../../account-security/components/account-deletion-dialog";
import {
  cancelAccountDeletion,
  downloadAccountDeletionExport,
  readAccountDeletionStatus,
} from "../../../account-security/data/account-deletion-client";
import { useSessionAuth } from "../../../lib/use-session-auth";
import { usePageTitle } from "../../lib/use-page-title";

function statusHeading(request: AccountDeletionStatusDto): string {
  switch (request.status) {
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

export default function AccountDeletionPage() {
  usePageTitle("Delete your Eliza account | Eliza Cloud");
  const session = useSessionAuth();
  const [request, setRequest] = useState<AccountDeletionStatusDto | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [cancelConfirmation, setCancelConfirmation] = useState("");
  const [canceling, setCanceling] = useState(false);
  const [exportConfirmation, setExportConfirmation] = useState("");
  const [exporting, setExporting] = useState(false);

  const refreshStatus = useCallback(async () => {
    setStatusLoading(true);
    setStatusError(null);
    try {
      setRequest(await readAccountDeletionStatus());
    } catch (cause) {
      // error-policy:J4 status failure remains visibly distinct from an empty
      // or completed deletion state.
      setStatusError(
        cause instanceof Error
          ? cause.message
          : "Deletion status is unavailable",
      );
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
  }, [refreshStatus]);

  const cancel = async () => {
    setCanceling(true);
    setStatusError(null);
    try {
      setRequest(await cancelAccountDeletion());
      setCancelConfirmation("");
    } catch (cause) {
      // error-policy:J4 cancellation failure remains visible and retryable.
      setStatusError(
        cause instanceof Error
          ? cause.message
          : "Deletion could not be canceled",
      );
    } finally {
      setCanceling(false);
    }
  };

  const downloadExport = async () => {
    setExporting(true);
    setStatusError(null);
    try {
      const download = await downloadAccountDeletionExport();
      const url = URL.createObjectURL(download.blob);
      try {
        await downloadAttachment(url, download.filename);
      } finally {
        URL.revokeObjectURL(url);
      }
      setExportConfirmation("");
      await refreshStatus();
    } catch (cause) {
      // error-policy:J4 export failure remains visible and never presents a
      // download as successful.
      setStatusError(
        cause instanceof Error
          ? cause.message
          : "Export could not be downloaded",
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <div
      className="theme-cloud h-[100dvh] overflow-y-auto bg-bg px-6 py-16 font-sans text-txt sm:px-8"
      data-scroll-cert-scroller
    >
      <main className="mx-auto max-w-3xl space-y-8">
        <div className="space-y-3 border-b border-border pb-6">
          <p className="text-sm font-medium text-accent">
            Eliza Cloud account deletion
          </p>
          <h1 className="text-4xl font-bold tracking-tight">
            Delete your account and data
          </h1>
          <p className="leading-relaxed text-muted-strong">
            This is the external deletion-request and recovery path for the
            Eliza app and Eliza Cloud. Status is accepted only from the opaque
            capability issued by the server, never from a URL parameter.
          </p>
        </div>

        {request ? (
          <section className="space-y-4 rounded-lg border border-success/40 bg-bg-elevated p-6">
            <CheckCircle2 className="h-7 w-7 text-success" />
            <h2 className="text-xl font-semibold">{statusHeading(request)}</h2>
            <p className="text-muted-strong">
              Request <code>{request.requestId}</code> is in
              server-authoritative state <strong>{request.status}</strong>.
            </p>
            {request.recoveryExpiresAt ? (
              <p className="text-sm text-muted-strong">
                Recovery is available through{" "}
                <time dateTime={request.recoveryExpiresAt}>
                  {request.recoveryExpiresAt}
                </time>
                . After that boundary, provider cleanup and erasure are
                irreversible.
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
                  htmlFor="export-deletion-confirmation"
                >
                  <span>
                    Type EXPORT MY DATA to build and download the archive
                  </span>
                  <Input
                    id="export-deletion-confirmation"
                    value={exportConfirmation}
                    onChange={(event) =>
                      setExportConfirmation(event.target.value)
                    }
                    autoComplete="off"
                    disabled={exporting}
                  />
                </label>
                <Button
                  variant="outline"
                  disabled={
                    exportConfirmation !== "EXPORT MY DATA" || exporting
                  }
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
                  htmlFor="cancel-deletion-confirmation"
                >
                  <span>Type CANCEL DELETION to restore account access</span>
                  <Input
                    id="cancel-deletion-confirmation"
                    value={cancelConfirmation}
                    onChange={(event) =>
                      setCancelConfirmation(event.target.value)
                    }
                    autoComplete="off"
                    disabled={canceling}
                  />
                </label>
                <Button
                  variant="outline"
                  disabled={
                    cancelConfirmation !== "CANCEL DELETION" || canceling
                  }
                  onClick={() => void cancel()}
                >
                  {canceling
                    ? "Canceling deletion…"
                    : "Cancel account deletion"}
                </Button>
              </div>
            ) : null}
            <Button
              variant="ghost"
              onClick={() => void refreshStatus()}
              disabled={statusLoading}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              {statusLoading ? "Refreshing…" : "Refresh server status"}
            </Button>
          </section>
        ) : (
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
              <AccountDeletionDialog onAccepted={setRequest} />
            ) : (
              <Link
                to="/login?returnTo=%2Faccount-deletion"
                className="inline-flex rounded-md bg-accent px-4 py-2 text-sm font-medium text-accent-foreground"
              >
                Sign in to request deletion
              </Link>
            )}
          </section>
        )}

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
          <p className="text-muted-strong">
            Email{" "}
            <a
              className="underline"
              href="mailto:support@eliza.cloud?subject=Eliza%20account%20deletion%20request"
            >
              support@eliza.cloud
            </a>{" "}
            from the address on your account. Include only your account email
            and the words “account deletion request.” Never send a password, API
            key, status capability, recovery capability, or wallet secret.
          </p>
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
