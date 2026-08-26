/** Play-safe account, permission, and deletion settings for Android Cloud. */

import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import { Input } from "../components/ui/input";
import type {
  AccountDeletionAvailabilityDto,
  AccountDeletionRequestDto,
} from "./account-deletion-contract";

export interface AndroidCloudAccountLifecycleAdapter {
  getStatus(): Promise<AccountDeletionRequestDto | null>;
  getAvailability?(): Promise<AccountDeletionAvailabilityDto>;
  requestDeletion(): Promise<AccountDeletionRequestDto>;
  cancelDeletion(): Promise<AccountDeletionRequestDto>;
  downloadExport(): Promise<boolean>;
}

export interface AndroidCloudSettingsProps {
  embedded?: boolean;
  displayName?: string;
  lifecycle?: AndroidCloudAccountLifecycleAdapter;
  initialRequest?: AccountDeletionRequestDto | null;
  backLabel?: string;
  onBack?(): void;
  onSignOut?(): Promise<void> | void;
  onDeletionReserved(request: AccountDeletionRequestDto): Promise<void> | void;
  openExternal(url: string): Promise<void> | void;
  openAppSettings?: () => Promise<void> | void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "The request could not be completed.";
}

function errorCode(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return null;
  }
  return typeof error.code === "string" ? error.code : null;
}

function formatDate(value: string | null): string | null {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function statusCopy(request: AccountDeletionRequestDto): {
  title: string;
  description: string;
} {
  switch (request.status) {
    case "reserved":
      return {
        title: "Securing your request",
        description:
          "Account access is fenced while Eliza prepares the encrypted recovery export.",
      };
    case "recovery":
      return {
        title: "Deletion requested",
        description:
          "Ordinary access is disabled. You can export your data or cancel until the recovery window ends.",
      };
    case "canceling":
      return {
        title: "Restoring account access",
        description:
          "Cancellation is being reconciled. Account access stays fenced until Eliza restores your identity and removes the recovery export. You will need to sign in again when cleanup finishes.",
      };
    case "scheduled":
      return {
        title: "Deletion scheduled",
        description:
          "The recovery window has ended. Permanent cleanup is queued and can no longer be cancelled.",
      };
    case "processing":
      return {
        title: "Deletion in progress",
        description:
          "The recovery window has ended. Account-owned data and external resources are being reconciled and removed.",
      };
    case "action_required":
      return {
        title: "Cleanup needs attention",
        description:
          "Your account remains disabled while a provider step is reconciled safely.",
      };
    case "completed":
      return {
        title: "Deletion complete",
        description:
          "Your account and associated account-owned data were deleted. Only a bounded non-identifying receipt remains.",
      };
    case "canceled":
      return {
        title: "Deletion cancelled",
        description:
          "Account access is restored. Existing sessions and API keys remain revoked, so sign in again to continue using Eliza.",
      };
  }
}

function DeletionStatus({
  request,
  lifecycle,
  onChange,
}: {
  request: AccountDeletionRequestDto;
  lifecycle?: AndroidCloudAccountLifecycleAdapter;
  onChange(request: AccountDeletionRequestDto): void;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [cancelText, setCancelText] = useState("");
  const [working, setWorking] = useState<"cancel" | "export" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exportSaved, setExportSaved] = useState(false);
  const copy = statusCopy(request);
  const deadline = formatDate(request.recoveryExpiresAt);

  const cancel = async () => {
    if (!lifecycle) return;
    setWorking("cancel");
    setError(null);
    try {
      onChange(await lifecycle.cancelDeletion());
      setConfirmCancel(false);
      setCancelText("");
    } catch (cause) {
      // error-policy:J4 Lifecycle cancellation failures remain visible while
      // the server-owned deletion state stays unchanged.
      setError(errorMessage(cause));
    } finally {
      setWorking(null);
    }
  };

  const downloadExport = async () => {
    if (!lifecycle) return;
    setWorking("export");
    setError(null);
    setExportSaved(false);
    try {
      setExportSaved(await lifecycle.downloadExport());
    } catch (cause) {
      // error-policy:J4 Export failures remain visible without fabricating a
      // saved file or changing the server-owned lifecycle state.
      setError(errorMessage(cause));
    } finally {
      setWorking(null);
    }
  };

  return (
    <section className="space-y-4 rounded-2xl border border-border bg-card p-5">
      <div>
        <h2 className="text-lg font-semibold">{copy.title}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted">
          {copy.description}
        </p>
      </div>
      {deadline && request.status === "recovery" ? (
        <p className="rounded-xl border border-status-warning/40 p-3 text-sm">
          Recovery ends <strong>{deadline}</strong>. Deletion cannot be
          cancelled after that time.
        </p>
      ) : null}
      {request.status === "action_required" ? (
        <p className="text-sm text-status-warning">
          Contact Eliza support with the receipt below so cleanup can be
          reconciled safely.
        </p>
      ) : null}
      {request.export?.status === "pending" ||
      request.export?.status === "building" ? (
        <p className="text-sm text-muted" role="status">
          Preparing your encrypted export…
        </p>
      ) : null}
      {exportSaved ? (
        <p className="text-sm text-status-success" role="status">
          Export saved to the location you selected.
        </p>
      ) : null}
      {error ? (
        <p className="text-sm text-status-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="grid gap-2">
        {request.export?.status === "ready" ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={!lifecycle || working !== null}
            onClick={() => void downloadExport()}
          >
            {working === "export" ? "Saving export…" : "Save data export"}
          </Button>
        ) : null}
        {request.canCancel ? (
          <Button
            type="button"
            variant="outline"
            size="touch"
            disabled={!lifecycle || working !== null}
            onClick={() => setConfirmCancel(true)}
          >
            Keep my account
          </Button>
        ) : null}
      </div>
      <p className="border-t border-border pt-3 text-xs text-muted">
        Support receipt: <code className="break-all">{request.requestId}</code>
      </p>
      {confirmCancel ? (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="android-cancel-deletion-title"
        >
          <section className="w-full space-y-4 rounded-2xl bg-card p-5 text-txt">
            <h2
              id="android-cancel-deletion-title"
              className="text-lg font-semibold"
            >
              Cancel account deletion?
            </h2>
            <p className="text-sm text-muted">
              Type CANCEL DELETION to confirm that you want to retain the
              account.
            </p>
            <label
              className="block text-sm"
              htmlFor="android-cancel-deletion-text"
            >
              Confirmation
              <Input
                id="android-cancel-deletion-text"
                variant="modal"
                density="relaxed"
                className="mt-2"
                value={cancelText}
                onChange={(event) => setCancelText(event.target.value)}
                autoComplete="off"
              />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={working === "cancel"}
                onClick={() => setConfirmCancel(false)}
              >
                Continue deletion
              </Button>
              <Button
                type="button"
                variant="default"
                size="touch"
                disabled={
                  cancelText !== "CANCEL DELETION" || working === "cancel"
                }
                onClick={() => void cancel()}
              >
                Keep account
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </section>
  );
}

export function AndroidCloudSettings({
  embedded = false,
  displayName,
  lifecycle,
  initialRequest = null,
  backLabel = "Back to chat",
  onBack,
  onSignOut,
  onDeletionReserved,
  openExternal,
  openAppSettings,
}: AndroidCloudSettingsProps): React.JSX.Element {
  const [request, setRequest] = useState(initialRequest);
  const [availability, setAvailability] =
    useState<AccountDeletionAvailabilityDto | null>(
      initialRequest
        ? { state: "existing_request", request: initialRequest }
        : null,
    );
  const [loading, setLoading] = useState(Boolean(lifecycle && !initialRequest));
  const [requestOpen, setRequestOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [admissionCode, setAdmissionCode] = useState<string | null>(null);

  const refresh = useCallback(
    async (hasExistingRequest: boolean) => {
      if (!lifecycle) return;
      setLoading(true);
      setError(null);
      try {
        const nextAvailability = hasExistingRequest
          ? await lifecycle
              .getStatus()
              .then(
                (nextRequest): AccountDeletionAvailabilityDto =>
                  nextRequest
                    ? { state: "existing_request", request: nextRequest }
                    : { state: "available", request: null },
              )
          : lifecycle.getAvailability
            ? await lifecycle.getAvailability()
            : await lifecycle
                .getStatus()
                .then(
                  (nextRequest): AccountDeletionAvailabilityDto =>
                    nextRequest
                      ? { state: "existing_request", request: nextRequest }
                      : { state: "available", request: null },
                );
        setAvailability(nextAvailability);
        setRequest(nextAvailability.request);
      } catch (cause) {
        // error-policy:J4 Status failures render explicitly; the server remains
        // authoritative if the user later retries an account action.
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [lifecycle],
  );

  useEffect(() => {
    if (!initialRequest) void refresh(false);
  }, [initialRequest, refresh]);

  useEffect(() => {
    if (!request) return;
    if (request.nextAction === "none") return;
    let active = true;
    let timer = window.setTimeout(async function poll() {
      await refresh(true);
      if (active) timer = window.setTimeout(poll, 5_000);
    }, 5_000);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refresh, request]);

  const submitDeletion = async () => {
    if (!lifecycle) return;
    setWorking(true);
    setError(null);
    setAdmissionCode(null);
    try {
      const next = await lifecycle.requestDeletion();
      setRequest(next);
      setRequestOpen(false);
      setConfirmation("");
      setAcknowledged(false);
      await onDeletionReserved(next);
    } catch (cause) {
      // error-policy:J4 Admission or reservation failures stay in the dialog
      // with their actionable server code; success is never inferred.
      setAdmissionCode(errorCode(cause));
      setError(errorMessage(cause));
    } finally {
      setWorking(false);
    }
  };

  return (
    <div
      className={
        embedded
          ? "space-y-5 text-txt"
          : "min-h-dvh overflow-y-auto bg-bg px-4 pb-10 pt-[max(1rem,env(safe-area-inset-top))] text-txt"
      }
    >
      {!embedded ? (
        <header className="mb-5 flex items-center gap-3">
          <Button
            type="button"
            variant="outline"
            size="touch"
            onClick={onBack}
            aria-label={backLabel}
          >
            Back
          </Button>
          <div>
            <h1 className="text-xl font-semibold">Settings</h1>
            {displayName ? (
              <p className="text-xs text-muted">{displayName}</p>
            ) : null}
          </div>
        </header>
      ) : null}

      <div className="space-y-5">
        {request && error ? (
          <p
            className="rounded-xl border border-status-danger/40 p-3 text-sm text-status-danger"
            role="alert"
          >
            {error} Eliza will retry without changing the server-owned state.
          </p>
        ) : null}
        {request ? (
          <DeletionStatus
            request={request}
            lifecycle={lifecycle}
            onChange={setRequest}
          />
        ) : (
          <>
            {!embedded ? (
              <section className="space-y-3 rounded-2xl border border-border bg-card p-5">
                <h2 className="font-semibold">Voice & app permissions</h2>
                <p className="text-sm leading-relaxed text-muted">
                  Microphone access is requested only when you start voice
                  dictation. Eliza uses standard Android speech recognition and
                  audio playback.
                </p>
                {openAppSettings ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    onClick={() => void openAppSettings()}
                  >
                    Open Android app settings
                  </Button>
                ) : null}
              </section>
            ) : null}

            {!embedded && onSignOut ? (
              <section className="space-y-3 rounded-2xl border border-border bg-card p-5">
                <h2 className="font-semibold">Privacy & data</h2>
                <p className="text-sm leading-relaxed text-muted">
                  Review what is deleted, export account data during the
                  recovery window, or permanently delete your account.
                </p>
                {loading ? (
                  <p className="text-sm text-muted" role="status">
                    Checking deletion status…
                  </p>
                ) : null}
                {error ? (
                  <p className="text-sm text-status-danger" role="alert">
                    {error}
                  </p>
                ) : null}
                {availability?.state === "lifecycle_unavailable" ? (
                  <p
                    className="rounded-xl border border-status-warning/40 p-3 text-sm text-status-warning"
                    role="status"
                  >
                    Account deletion is temporarily unavailable. Your account,
                    access, and data are unchanged. Use the web request page for
                    current support options.
                  </p>
                ) : null}
                {availability?.state === "transfer_required" ? (
                  <p
                    className="rounded-xl border border-status-warning/40 p-3 text-sm text-status-warning"
                    role="status"
                  >
                    Transfer or revoke shared organization resources before
                    deleting this account.
                  </p>
                ) : null}
                <div className="grid gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="touch"
                    onClick={() =>
                      void openExternal("https://eliza.app/account-deletion")
                    }
                  >
                    Deletion policy & web request
                  </Button>
                  <Button
                    type="button"
                    variant="dangerOutline"
                    size="touch"
                    disabled={
                      !lifecycle ||
                      loading ||
                      availability?.state !== "available"
                    }
                    onClick={() => {
                      setError(null);
                      setAdmissionCode(null);
                      setRequestOpen(true);
                    }}
                  >
                    Delete account & data
                  </Button>
                </div>
              </section>
            ) : null}

            {!embedded && onSignOut ? (
              <section className="space-y-3 rounded-2xl border border-border bg-card p-5">
                <h2 className="font-semibold">Account</h2>
                <Button
                  type="button"
                  variant="outline"
                  size="touch"
                  className="w-full"
                  onClick={() => void onSignOut()}
                >
                  Sign out
                </Button>
              </section>
            ) : null}
          </>
        )}
      </div>

      {requestOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-end bg-black/70 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="android-delete-account-title"
        >
          <section className="max-h-[90dvh] w-full space-y-4 overflow-y-auto rounded-2xl bg-card p-5 text-txt">
            <h2
              id="android-delete-account-title"
              className="text-lg font-semibold"
            >
              Permanently delete your Eliza account?
            </h2>
            <p className="text-sm leading-relaxed text-muted">
              The server first disables ordinary access and new paid activity
              and opens a recovery window. During that window you can export or
              cancel. After it ends, deletion is irreversible. Shared
              organization data requires an active successor owner.
            </p>
            <div className="flex items-start gap-3 text-sm">
              <Checkbox
                id="android-delete-account-acknowledgement"
                className="mt-1"
                checked={acknowledged}
                onCheckedChange={(checked) => setAcknowledged(checked === true)}
              />
              <label htmlFor="android-delete-account-acknowledgement">
                I understand account access is disabled after safe reservation
                and deletion becomes permanent after the recovery window.
              </label>
            </div>
            <label
              className="block text-sm"
              htmlFor="android-delete-account-text"
            >
              Type DELETE to confirm
              <Input
                id="android-delete-account-text"
                variant="modal"
                density="relaxed"
                className="mt-2"
                value={confirmation}
                onChange={(event) => setConfirmation(event.target.value)}
                autoComplete="off"
              />
            </label>
            {error ? (
              <div
                className="space-y-2 text-sm text-status-danger"
                role="alert"
              >
                <p>{error}</p>
                {admissionCode === "TRANSFER_REQUIRED" ? (
                  <Button
                    type="button"
                    variant="dangerGhost"
                    size="content"
                    align="start"
                    onClick={() =>
                      void openExternal(
                        "https://eliza.app/settings#cloud-organization",
                      )
                    }
                  >
                    Transfer shared organization ownership
                  </Button>
                ) : null}
                {admissionCode === "RECENT_AUTH_REQUIRED" ? (
                  <Button
                    type="button"
                    variant="dangerGhost"
                    size="content"
                    align="start"
                    onClick={() =>
                      void openExternal(
                        "https://eliza.app/login?returnTo=%2Fsettings%23cloud-security",
                      )
                    }
                  >
                    Verify your identity again
                  </Button>
                ) : null}
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-2">
              <Button
                type="button"
                variant="outline"
                size="touch"
                disabled={working}
                onClick={() => setRequestOpen(false)}
              >
                Keep account
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="touch"
                disabled={!acknowledged || confirmation !== "DELETE" || working}
                onClick={() => void submitDeletion()}
              >
                {working ? "Reserving…" : "Delete account"}
              </Button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

export default AndroidCloudSettings;
