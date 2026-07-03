/**
 * Hosted public page for an approval request. Reads the redacted public view
 * from /api/v1/approval-requests/:id?public=1 and presents the challenge +
 * signature form. Approve/deny are public; the server-side
 * IdentityVerificationGatekeeper validates the pasted signature.
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
import { Button } from "../../../../components/ui/button";
import { Textarea } from "../../../../components/ui/textarea";
import { ApiError, api } from "../../../lib/api-client";
import { useCloudT } from "../../../shell/CloudI18nProvider";
import { usePageTitle } from "../../lib/use-page-title";

type TFn = ReturnType<typeof useCloudT>;

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

function statusLabel(status: ApprovalRequestStatus, t: TFn): string {
  switch (status) {
    case "approved":
      return t("cloud.approval.statusApproved", { defaultValue: "Approved" });
    case "denied":
      return t("cloud.approval.statusDenied", { defaultValue: "Denied" });
    case "expired":
      return t("cloud.approval.statusExpired", { defaultValue: "Expired" });
    case "canceled":
      return t("cloud.approval.statusCanceled", { defaultValue: "Canceled" });
    case "delivered":
      return t("cloud.approval.statusAwaiting", {
        defaultValue: "Awaiting signature",
      });
    default:
      return t("cloud.approval.statusPending", { defaultValue: "Pending" });
  }
}

export default function ApprovalPage() {
  const t = useCloudT();
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

  usePageTitle(
    t("cloud.approval.metaTitle", {
      defaultValue: "Approval Request | Eliza Cloud",
    }),
  );

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
      setLoadError(
        error instanceof ApiError
          ? error.message
          : t("cloud.approval.loadFailed", {
              defaultValue: "Failed to load approval request",
            }),
      );
    } finally {
      setLoading(false);
    }
  }, [approvalId, t]);

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
      setSubmitError(
        error instanceof ApiError
          ? error.message
          : t("cloud.approval.submitFailed", {
              defaultValue: "Failed to submit signature",
            }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [approvalId, signature, t]);

  const handleDeny = useCallback(async () => {
    if (!approvalId || !signature.trim()) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const response = await api<ApproveResponse>(
        `/api/v1/approval-requests/${encodeURIComponent(approvalId)}/deny`,
        {
          method: "POST",
          json: {
            reason: "denied by signer",
            signature: signature.trim(),
          },
          skipAuth: true,
        },
      );
      setRequest(response.approvalRequest);
      setSubmitResult("denied");
    } catch (error) {
      setSubmitError(
        error instanceof ApiError
          ? error.message
          : t("cloud.approval.denyFailed", {
              defaultValue: "Failed to deny approval",
            }),
      );
    } finally {
      setSubmitting(false);
    }
  }, [approvalId, signature, t]);

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
          {t("cloud.approval.couldNotLoad", {
            defaultValue: "Could not load approval request",
          })}
        </h1>
        <p className="text-sm text-zinc-500">
          {loadError ??
            t("cloud.approval.unknownError", {
              defaultValue: "Unknown error",
            })}
        </p>
      </div>
    );
  }

  const challenge = request.challengePayload;
  const signerKind = challenge.signerKind;
  const expiresAt = formatTimestamp(request.expiresAt);

  return (
    <div className="mx-auto max-w-xl p-6">
      <div className="flex items-center gap-2">
        <ShieldCheck className="h-6 w-6 text-[#FF5800]" />
        <h1 className="text-xl font-semibold">
          {t("cloud.approval.heading", { defaultValue: "Approval request" })}
        </h1>
      </div>

      <div className="mt-4 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <dl className="grid grid-cols-1 gap-3 text-sm">
          <div>
            <dt className="text-zinc-500">
              {t("cloud.approval.kind", { defaultValue: "Kind" })}
            </dt>
            <dd className="font-mono">{request.challengeKind}</dd>
          </div>
          <div>
            <dt className="text-zinc-500">
              {t("cloud.approval.status", { defaultValue: "Status" })}
            </dt>
            <dd>{statusLabel(request.status, t)}</dd>
          </div>
          {expiresAt ? (
            <div>
              <dt className="text-zinc-500">
                {t("cloud.approval.expires", { defaultValue: "Expires" })}
              </dt>
              <dd>{expiresAt}</dd>
            </div>
          ) : null}
          {request.expectedSignerIdentityId ? (
            <div>
              <dt className="text-zinc-500">
                {t("cloud.approval.expectedSigner", {
                  defaultValue: "Expected signer",
                })}
              </dt>
              <dd className="break-all font-mono text-xs">
                {request.expectedSignerIdentityId}
              </dd>
            </div>
          ) : null}
          {signerKind ? (
            <div>
              <dt className="text-zinc-500">
                {t("cloud.approval.signerKind", {
                  defaultValue: "Signer kind",
                })}
              </dt>
              <dd>{signerKind}</dd>
            </div>
          ) : null}
        </dl>

        {challenge.message ? (
          <div className="mt-4">
            <p className="text-xs uppercase tracking-wide text-zinc-500">
              {t("cloud.approval.challengeMessage", {
                defaultValue: "Challenge message",
              })}
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
          {t("cloud.approval.signatureAccepted", {
            defaultValue: "Signature accepted.",
          })}
        </div>
      ) : null}

      {submitResult === "denied" ? (
        <div className="mt-6 flex items-center gap-2 rounded-lg border border-zinc-300 bg-zinc-50 p-3 text-sm text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300">
          <XCircle className="h-5 w-5" />
          {t("cloud.approval.approvalDenied", {
            defaultValue: "Approval denied.",
          })}
        </div>
      ) : null}

      {!isTerminal && !submitResult ? (
        <div className="mt-6 space-y-3">
          <label
            htmlFor="approval-signature"
            className="block text-sm font-medium"
          >
            {t("cloud.approval.signature", { defaultValue: "Signature" })}
          </label>
          <Textarea
            id="approval-signature"
            value={signature}
            onChange={(event) => setSignature(event.target.value)}
            placeholder={
              signerKind === "wallet"
                ? "0x..."
                : signerKind === "ed25519"
                  ? t("cloud.approval.placeholderEd25519", {
                      defaultValue: "base64 ed25519 signature",
                    })
                  : t("cloud.approval.placeholderPaste", {
                      defaultValue: "Paste signature",
                    })
            }
            rows={4}
            className="w-full rounded border border-zinc-300 bg-white p-2 font-mono text-xs dark:border-zinc-700 dark:bg-zinc-950"
          />
          {submitError ? (
            <p className="text-sm text-red-600">{submitError}</p>
          ) : null}
          <div className="flex gap-2">
            <Button
              variant="ghost"
              type="button"
              onClick={handleApprove}
              disabled={submitting || signature.trim().length === 0}
              className="inline-flex items-center gap-2 rounded bg-[#FF5800] hover:bg-[#e54f00] px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
            >
              {submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              {t("cloud.approval.approve", { defaultValue: "Approve" })}
            </Button>
            <Button
              variant="ghost"
              type="button"
              onClick={handleDeny}
              disabled={submitting || signature.trim().length === 0}
              className="inline-flex items-center gap-2 rounded border border-zinc-300 px-4 py-2 text-sm dark:border-zinc-700"
            >
              {t("cloud.approval.deny", { defaultValue: "Deny" })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
