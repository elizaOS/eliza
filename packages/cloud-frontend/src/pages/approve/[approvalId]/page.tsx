/**
 * Hosted public page for an approval request (Wave D).
 *
 * Reads the redacted public view from /api/v1/approval-requests/:id?public=1
 * and presents the challenge message + signature form. The signer pastes a
 * signature produced out-of-band (wallet UI, hardware device, agent CLI) and
 * submits it to /approve. Approve and deny endpoints are public and rely on
 * the IdentityVerificationGatekeeper to validate the signature server-side.
 */

import {
  AlertCircle,
  CheckCircle2,
  Loader2,
  ShieldCheck,
  XCircle,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { ApiError, api } from "../../../lib/api-client";

type ApprovalChallengeKind = "login" | "signature" | "generic";
type ApprovalSignerKind = "wallet" | "ed25519";
type ApprovalRequestStatus =
  | "pending"
  | "delivered"
  | "approved"
  | "denied"
  | "expired"
  | "canceled";

interface PublicApprovalChallengePayload {
  message?: string;
  signerKind?: ApprovalSignerKind;
  walletAddress?: string;
  publicKey?: string;
  context?: Record<string, unknown>;
}

interface PublicApprovalRequest {
  id: string;
  organizationId: string;
  agentId: string | null;
  userId: string | null;
  challengeKind: ApprovalChallengeKind;
  challengePayload: PublicApprovalChallengePayload;
  expectedSignerIdentityId: string | null;
  status: ApprovalRequestStatus;
  expiresAt: string;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown> | null;
}

interface PublicResponse {
  success: boolean;
  approvalRequest: PublicApprovalRequest;
}

interface ApproveResponse {
  success: boolean;
  signerIdentityId?: string;
  approvalRequest: PublicApprovalRequest;
}

function formatTimestamp(value: string | null): string | null {
  if (!value) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function statusLabel(status: ApprovalRequestStatus): string {
  switch (status) {
    case "approved":
      return "Approved";
    case "denied":
      return "Denied";
    case "expired":
      return "Expired";
    case "canceled":
      return "Canceled";
    case "delivered":
      return "Awaiting signature";
    default:
      return "Pending";
  }
}

export default function ApprovalPage() {
  const params = useParams<{ approvalId: string }>();
  const approvalId = params.approvalId ?? "";
  const [request, setRequest] = useState<PublicApprovalRequest | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [signature, setSignature] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitResult, setSubmitResult] = useState<
    "approved" | "denied" | null
  >(null);

  const fetchRequest = useCallback(async () => {
    if (!approvalId) return;
    setLoading(true);
    setLoadError(null);
    try {
      const response = await api<PublicResponse>(
        `/api/v1/approval-requests/${encodeURIComponent(approvalId)}?public=1`,
        { skipAuth: true },
      );
      setRequest(response.approvalRequest);
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Failed to load approval request";
      setLoadError(message);
    } finally {
      setLoading(false);
    }
  }, [approvalId]);

  useEffect(() => {
    fetchRequest();
  }, [fetchRequest]);

  const isTerminal = useMemo(() => {
    if (!request) return false;
    return (
      request.status === "approved" ||
      request.status === "denied" ||
      request.status === "expired" ||
      request.status === "canceled"
    );
  }, [request]);

  const handleApprove = useCallback(async () => {
    if (!approvalId || !signature.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await api<ApproveResponse>(
        `/api/v1/approval-requests/${encodeURIComponent(approvalId)}/approve`,
        {
          method: "POST",
          json: { signature: signature.trim() },
          skipAuth: true,
        },
      );
      setRequest(response.approvalRequest);
      setSubmitResult("approved");
    } catch (error) {
      const message =
        error instanceof ApiError
          ? error.message
          : "Failed to submit signature";
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  }, [approvalId, signature]);

  const handleDeny = useCallback(async () => {
    if (!approvalId) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await api<ApproveResponse>(
        `/api/v1/approval-requests/${encodeURIComponent(approvalId)}/deny`,
        {
          method: "POST",
          json: { reason: "denied by signer" },
          skipAuth: true,
        },
      );
      setRequest(response.approvalRequest);
      setSubmitResult("denied");
    } catch (error) {
      const message =
        error instanceof ApiError ? error.message : "Failed to deny approval";
      setSubmitError(message);
    } finally {
      setSubmitting(false);
    }
  }, [approvalId]);

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
      </div>
    );
  }

  if (loadError || !request) {
    return (
      <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
        <AlertCircle className="h-8 w-8 text-red-500" />
        <h1 className="text-lg font-semibold">
          Could not load approval request
        </h1>
        <p className="text-sm text-zinc-500">{loadError ?? "Unknown error"}</p>
      </div>
    );
  }

  const challenge = request.challengePayload;
  const signerKind = challenge.signerKind;
  const expiresAt = formatTimestamp(request.expiresAt);

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-blue-500" />
        <h1 className="text-xl font-semibold">Approval request</h1>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <dl className="grid grid-cols-1 gap-3 text-sm">
          <div>
            <dt className="text-zinc-500">Kind</dt>
            <dd className="font-mono">{request.challengeKind}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">Status</dt>
            <dd>{statusLabel(request.status)}</dd>
          </div>
          {expiresAt ? (
            <div>
              <dt className="text-zinc-500">Expires</dt>
              <dd>{expiresAt}</dd>
            </div>
          ) : null}
          {request.expectedSignerIdentityId ? (
            <div>
              <dt className="text-zinc-500">Expected signer</dt>
              <dd className="break-all font-mono text-xs">
                {request.expectedSignerIdentityId}
              </dd>
            </div>
          ) : null}
          {signerKind ? (
            <div>
              <dt className="text-zinc-500">Signer kind</dt>
              <dd>{signerKind}</dd>
            </div>
          ) : null}
        </dl>

        {challenge.message ? (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              Challenge message
            </p>
            <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-zinc-50 p-3 text-xs dark:bg-zinc-900">
              {challenge.message}
            </pre>
          </div>
        ) : null}
      </div>

      {submitResult === "approved" ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950 dark:text-green-200">
          <CheckCircle2 className="h-5 w-5" />
          Signature accepted.
        </div>
      ) : null}

      {submitResult === "denied" ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <XCircle className="h-5 w-5" />
          Approval denied.
        </div>
      ) : null}

      {!isTerminal && !submitResult ? (
        <div className="mt-6 space-y-3">
          <label className="block text-sm font-medium">Signature</label>
          <textarea
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
            placeholder={
              signerKind === "wallet"
                ? "0x..."
                : signerKind === "ed25519"
                  ? "base64 ed25519 signature"
                  : "Paste signature"
            }
            rows={4}
            className="w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          {submitError ? (
            <p className="text-sm text-red-600">{submitError}</p>
          ) : null}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={handleApprove}
              disabled={submitting || signature.trim().length === 0}
              className="inline-flex items-center gap-2 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Approve
            </button>
            <button
              type="button"
              onClick={handleDeny}
              disabled={submitting}
              className="inline-flex items-center gap-2 rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
            >
              Deny
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
