/**
 * Admin Resolution Review Queue
 *
 * Lists low-confidence prediction question resolutions that require manual review.
 */

"use client";

export const dynamic = "force-dynamic";

import { cn, formatDateTime } from "@feed/shared";
import {
  ExternalLink,
  Loader2,
  RefreshCw,
  Shield,
  ShieldAlert,
} from "lucide-react";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { AdminStandalonePage } from "@/components/admin/AdminStandalonePage";
import { Skeleton } from "@/components/shared/Skeleton";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/hooks/useAuth";
import { apiUrl } from "@/utils/api-url";

type PendingResolution = {
  id: string;
  questionNumber: number;
  text: string;
  outcome: boolean;
  resolutionDate: string | null;
  resolutionProofUrl: string | null;
  resolutionDescription: string | null;
  resolutionConfidence: number | null;
  resolutionReviewStatus: "pending" | "approved" | "rejected" | null;
  requiresManualReview: boolean;
  updatedAt: string | null;
};

/** Runtime type guard for PendingResolution */
function isPendingResolution(value: unknown): value is PendingResolution {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.id === "string" &&
    typeof obj.questionNumber === "number" &&
    typeof obj.text === "string" &&
    typeof obj.outcome === "boolean" &&
    typeof obj.requiresManualReview === "boolean"
  );
}

/** Extract error message from API response with runtime validation */
function extractErrorMessage(data: unknown, fallback: string): string {
  if (typeof data !== "object" || data === null) return fallback;
  const obj = data as Record<string, unknown>;
  if (typeof obj.error !== "object" || obj.error === null) return fallback;
  const err = obj.error as Record<string, unknown>;
  return typeof err.message === "string" ? err.message : fallback;
}

export default function AdminResolutionsPage() {
  const router = useRouter();
  const { authenticated, ready } = useAuth();
  const [items, setItems] = useState<PendingResolution[]>([]);
  const [loading, setLoading] = useState(true);
  const [submittingId, setSubmittingId] = useState<string | null>(null);
  const [isAuthorized, setIsAuthorized] = useState<boolean | null>(null);
  const [rejectConfirm, setRejectConfirm] = useState<PendingResolution | null>(
    null,
  );

  const checkAdminAccess = useCallback(async () => {
    if (!ready) return;

    if (!authenticated) {
      router.push("/");
      return;
    }

    // Check admin access by attempting to fetch the resolution queue
    try {
      const res = await fetch(apiUrl("/api/admin/resolutions"));
      if (!res.ok) {
        setIsAuthorized(false);
        setLoading(false);
        return;
      }
      setIsAuthorized(true);
    } catch {
      setIsAuthorized(false);
      setLoading(false);
    }
  }, [authenticated, ready, router]);

  useEffect(() => {
    checkAdminAccess();
  }, [checkAdminAccess]);

  const fetchQueue = useCallback(async () => {
    if (!isAuthorized) return;
    setLoading(true);
    try {
      const res = await fetch(apiUrl("/api/admin/resolutions"));
      let data: unknown;
      try {
        data = await res.json();
      } catch {
        throw new Error("Invalid response from server");
      }
      if (!res.ok) {
        throw new Error(
          extractErrorMessage(data, "Failed to load resolution queue"),
        );
      }
      const payload = data as { items?: unknown[] };
      const validItems = Array.isArray(payload?.items)
        ? payload.items.filter(isPendingResolution)
        : [];
      setItems(validItems);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load queue");
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [isAuthorized]);

  useEffect(() => {
    if (isAuthorized) {
      fetchQueue();
    }
  }, [isAuthorized, fetchQueue]);

  const pendingCount = useMemo(
    () => items.filter((i) => i.resolutionReviewStatus === "pending").length,
    [items],
  );

  const act = useCallback(
    async (id: string, action: "approve" | "reject") => {
      setSubmittingId(id);
      try {
        const res = await fetch(apiUrl(`/api/admin/resolutions/${id}`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action }),
        });
        let data: unknown;
        try {
          data = await res.json();
        } catch {
          throw new Error(`Invalid response for ${action} on question ${id}`);
        }
        if (!res.ok) {
          throw new Error(extractErrorMessage(data, "Action failed"));
        }
        await fetchQueue();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Action failed");
      } finally {
        setSubmittingId(null);
      }
    },
    [fetchQueue],
  );

  // Show loading skeleton while checking auth
  if (!ready || isAuthorized === null) {
    return (
      <AdminStandalonePage>
        <Skeleton className="mb-4 h-8 w-64" />
        <Skeleton className="h-4 w-96" />
      </AdminStandalonePage>
    );
  }

  // Show access denied for non-admins
  if (!isAuthorized) {
    return (
      <AdminStandalonePage className="flex min-h-full flex-col items-center justify-center text-center">
        <Shield className="mb-4 h-16 w-16 text-muted-foreground" />
        <h1 className="mb-2 font-bold text-2xl">Access Denied</h1>
        <p className="text-muted-foreground">
          You don&apos;t have permission to access the resolution review queue.
        </p>
      </AdminStandalonePage>
    );
  }

  return (
    <AdminStandalonePage>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h1 className="font-bold text-2xl">Resolution Review Queue</h1>
          <p className="text-muted-foreground">
            Low-confidence resolutions requiring manual approval before markets
            resolve.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => fetchQueue()}
            disabled={loading}
            title="Refresh queue"
          >
            <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
          </Button>
          <div
            className={cn(
              "inline-flex items-center gap-2 rounded-md border px-3 py-2 text-sm",
              pendingCount > 0 ? "border-yellow-500/30 bg-yellow-500/10" : "",
            )}
          >
            <ShieldAlert className="h-4 w-4" />
            <span>{pendingCount} pending</span>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-muted-foreground">Loading…</div>
      ) : items.length === 0 ? (
        <div className="rounded-lg border border-border bg-card p-6 text-muted-foreground">
          No pending resolution reviews.
        </div>
      ) : (
        <div className="space-y-4">
          {items.map((q) => (
            <div
              key={q.id}
              className="rounded-lg border border-border bg-card p-5"
            >
              <div className="flex flex-col gap-3">
                <div className="flex items-start justify-between gap-4">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-muted-foreground text-xs">
                      <span>Q{q.questionNumber}</span>
                      <span>•</span>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 font-medium",
                          q.outcome
                            ? "bg-green-500/10 text-green-600"
                            : "bg-red-500/10 text-red-600",
                        )}
                      >
                        {q.outcome ? "YES" : "NO"}
                      </span>
                      <span>•</span>
                      <span>
                        {q.resolutionDate
                          ? formatDateTime(q.resolutionDate)
                          : "n/a"}
                      </span>
                      {q.resolutionConfidence !== null ? (
                        <>
                          <span>•</span>
                          <span>
                            {(q.resolutionConfidence * 100).toFixed(0)}%
                            confidence
                          </span>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-1 line-clamp-2 font-medium">
                      {q.text}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-2">
                    {q.resolutionProofUrl ? (
                      <a
                        href={q.resolutionProofUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-primary text-sm hover:underline"
                      >
                        Proof <ExternalLink className="h-4 w-4" />
                      </a>
                    ) : null}
                  </div>
                </div>

                {q.resolutionDescription ? (
                  <div className="rounded-md bg-muted/30 p-3 text-sm">
                    {q.resolutionDescription}
                  </div>
                ) : (
                  <div className="rounded-md bg-muted/30 p-3 text-muted-foreground text-sm">
                    No proof/description stored yet.
                  </div>
                )}

                <div className="flex items-center gap-2">
                  <Button
                    disabled={submittingId === q.id}
                    onClick={() => act(q.id, "approve")}
                  >
                    {submittingId === q.id ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    Approve
                  </Button>
                  <Button
                    variant="outline"
                    className="border-red-500/30 text-red-600 hover:bg-red-500/10"
                    disabled={submittingId === q.id}
                    onClick={() => setRejectConfirm(q)}
                  >
                    Reject
                  </Button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reject Confirmation Dialog */}
      <AlertDialog
        open={rejectConfirm !== null}
        onOpenChange={(open) => !open && setRejectConfirm(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Reject Resolution?</AlertDialogTitle>
            <AlertDialogDescription>
              This will clear the stored proof and postpone the resolution by 24
              hours. The question will need to be re-evaluated.
              {rejectConfirm && (
                <div className="mt-2 rounded-md bg-muted/50 p-2 text-foreground">
                  Q{rejectConfirm.questionNumber}: {rejectConfirm.text}
                </div>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-red-600 hover:bg-red-700"
              onClick={() => {
                if (rejectConfirm) {
                  act(rejectConfirm.id, "reject");
                  setRejectConfirm(null);
                }
              }}
            >
              {submittingId === rejectConfirm?.id ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : null}
              Reject
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AdminStandalonePage>
  );
}
