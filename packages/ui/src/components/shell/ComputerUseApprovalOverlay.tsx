import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";
import { StatusBadge } from "../ui/status-badge";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type ComputerUseApprovalSnapshot, client } from "../../api/client";
import { useApp } from "../../state";

const OVERLAY_SHELL_CLASS =
  "fixed inset-0 z-[1002] flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg/75 px-4 py-6 font-body text-txt backdrop-blur-sm sm:px-6";
const OVERLAY_CARD_CLASS =
  "relative z-10 w-full max-w-[820px] overflow-hidden border border-border/60 bg-card/95 shadow-[0_30px_120px_rgba(0,0,0,0.36)] backdrop-blur-xl";
const EMPTY_SNAPSHOT: ComputerUseApprovalSnapshot = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
};
const POLL_MS = 1500;

function approvalStreamUrl(): string {
  const baseUrl = client.getBaseUrl();
  const restToken = client.getRestAuthToken();
  const url = new URL(
    "/api/computer-use/approvals/stream",
    baseUrl || window.location.origin,
  );
  if (restToken) {
    url.searchParams.set("token", restToken);
  }
  return url.toString();
}

export function ComputerUseApprovalOverlay() {
  const { setActionNotice, t } = useApp();
  const [snapshot, setSnapshot] =
    useState<ComputerUseApprovalSnapshot>(EMPTY_SNAPSHOT);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [denyTargetId, setDenyTargetId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");

  const refresh = useCallback(async () => {
    try {
      setSnapshot(await client.getComputerUseApprovals());
    } catch {
      setSnapshot(EMPTY_SNAPSHOT);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let pollingTimer: number | null = null;
    let eventSource: EventSource | null = null;

    const startPolling = () => {
      if (pollingTimer !== null) {
        return;
      }
      void refresh();
      pollingTimer = window.setInterval(() => {
        void refresh();
      }, POLL_MS);
    };

    try {
      eventSource = new EventSource(approvalStreamUrl());
      eventSource.onmessage = (event) => {
        if (cancelled) {
          return;
        }
        try {
          const payload = JSON.parse(event.data) as {
            type?: string;
            snapshot?: ComputerUseApprovalSnapshot;
          };
          if (payload.type === "snapshot" && payload.snapshot) {
            setSnapshot(payload.snapshot);
            if (pollingTimer !== null) {
              window.clearInterval(pollingTimer);
              pollingTimer = null;
            }
          }
        } catch {
          // Ignore malformed events.
        }
      };
      eventSource.onerror = () => {
        eventSource?.close();
        eventSource = null;
        startPolling();
      };
    } catch {
      startPolling();
    }

    if (!eventSource) {
      startPolling();
    }

    return () => {
      cancelled = true;
      if (pollingTimer !== null) {
        window.clearInterval(pollingTimer);
      }
      eventSource?.close();
    };
  }, [refresh]);

  const visibleApprovals = snapshot.pendingApprovals;
  const approvalCards = useMemo(
    () =>
      visibleApprovals.map((approval) => ({
        ...approval,
        parametersText: JSON.stringify(approval.parameters ?? {}, null, 2),
      })),
    [visibleApprovals],
  );

  const handleRespond = useCallback(
    async (approvalId: string, approved: boolean, reason?: string) => {
      if (busyApprovalId) {
        return;
      }

      setBusyApprovalId(approvalId);
      try {
        const resolution = await client.respondToComputerUseApproval(
          approvalId,
          approved,
          reason,
        );
        setActionNotice(
          approved
            ? t("computeruseapprovaloverlay.ApprovedNotice", {
                defaultValue: `Approved ${resolution.command}.`,
              })
            : t("computeruseapprovaloverlay.RejectedNotice", {
                defaultValue: `Rejected ${resolution.command}.`,
              }),
          approved ? "success" : "info",
          2600,
        );
        setDenyTargetId(null);
        setDenyReason("");
        await refresh();
      } catch (error) {
        setActionNotice(
          error instanceof Error
            ? error.message
            : t("computeruseapprovaloverlay.ResolveFailed", {
                defaultValue: "Failed to resolve computer-use approval.",
              }),
          "error",
          3600,
        );
      } finally {
        setBusyApprovalId(null);
      }
    },
    [busyApprovalId, refresh, setActionNotice, t],
  );

  if (approvalCards.length === 0) {
    return null;
  }

  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="computer-use-approval-title"
      className={OVERLAY_SHELL_CLASS}
    >
      <Card className={OVERLAY_CARD_CLASS}>
        <CardHeader className="bg-warning/5 pb-6 pt-6">
          <div className="flex flex-col gap-4">
            <StatusBadge
              label={t("computeruseapprovaloverlay.PendingApproval", {
                defaultValue: "Computer Use Approval",
              })}
              variant="warning"
              withDot
              className="self-start"
            />
            <div className="space-y-2">
              <h1
                id="computer-use-approval-title"
                className="text-xl font-semibold leading-tight text-txt"
              >
                {t("computeruseapprovaloverlay.Title", {
                  defaultValue: "Review queued computer actions",
                })}
              </h1>
              <CardDescription className="max-w-[62ch] leading-relaxed">
                {t("computeruseapprovaloverlay.Body", {
                  defaultValue:
                    "The agent requested local computer-use actions that need approval before they run.",
                })}
              </CardDescription>
              <div className="text-xs text-muted">
                {t("computeruseapprovaloverlay.ModeLine", {
                  defaultValue: "Approval mode: {{mode}}.",
                  mode: snapshot.mode,
                })}
              </div>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex max-h-[70vh] flex-col gap-4 overflow-auto pt-6">
          {approvalCards.map((approval) => {
            const busy = busyApprovalId === approval.id;
            const isDenying = denyTargetId === approval.id;
            return (
              <div
                key={approval.id}
                className="rounded-2xl border border-border/50 bg-card/75 p-4 shadow-sm"
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
                      {t("computeruseapprovaloverlay.Command", {
                        defaultValue: "Command",
                      })}
                    </div>
                    <div className="mt-2 break-all text-sm font-medium text-txt">
                      {approval.command}
                    </div>
                    <div className="mt-2 text-xs text-muted">
                      {new Date(approval.requestedAt).toLocaleTimeString()}
                    </div>
                    <pre className="mt-4 max-h-56 overflow-auto rounded-xl bg-bg/60 p-3 text-xs leading-relaxed text-txt">
                      {approval.parametersText || "{}"}
                    </pre>
                  </div>

                  <div className="w-full max-w-[18rem] space-y-3">
                    {isDenying ? (
                      <>
                        <label
                          htmlFor="computer-use-deny-reason"
                          className="block text-xs font-semibold uppercase tracking-[0.16em] text-muted"
                        >
                          {t("computeruseapprovaloverlay.DenyReason", {
                            defaultValue: "Deny reason",
                          })}
                        </label>
                        <textarea
                          id="computer-use-deny-reason"
                          value={denyReason}
                          onChange={(event) =>
                            setDenyReason(event.target.value)
                          }
                          rows={4}
                          className="w-full rounded-xl border border-border/60 bg-bg/50 px-3 py-2 text-sm text-txt outline-none"
                          placeholder={t(
                            "computeruseapprovaloverlay.DenyReasonPlaceholder",
                            {
                              defaultValue:
                                "Optional reason shown to the agent.",
                            },
                          )}
                        />
                        <div className="flex gap-2">
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => {
                              setDenyTargetId(null);
                              setDenyReason("");
                            }}
                            className="flex-1"
                          >
                            {t("common.cancel", { defaultValue: "Cancel" })}
                          </Button>
                          <Button
                            variant="outline"
                            disabled={busy}
                            onClick={() => {
                              void handleRespond(
                                approval.id,
                                false,
                                denyReason.trim() || undefined,
                              );
                            }}
                            className="flex-1"
                          >
                            {busy
                              ? t("computeruseapprovaloverlay.Resolving", {
                                  defaultValue: "Resolving...",
                                })
                              : t("computeruseapprovaloverlay.Reject", {
                                  defaultValue: "Reject",
                                })}
                          </Button>
                        </div>
                      </>
                    ) : (
                      <div className="flex flex-col gap-2">
                        <Button
                          variant="default"
                          disabled={busyApprovalId !== null}
                          onClick={() => {
                            void handleRespond(approval.id, true);
                          }}
                        >
                          {busy
                            ? t("computeruseapprovaloverlay.Resolving", {
                                defaultValue: "Resolving...",
                              })
                            : t("computeruseapprovaloverlay.Approve", {
                                defaultValue: "Approve",
                              })}
                        </Button>
                        <Button
                          variant="outline"
                          disabled={busyApprovalId !== null}
                          onClick={() => {
                            setDenyTargetId(approval.id);
                            setDenyReason("");
                          }}
                        >
                          {t("computeruseapprovaloverlay.Reject", {
                            defaultValue: "Reject",
                          })}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>
    </div>
  );
}
