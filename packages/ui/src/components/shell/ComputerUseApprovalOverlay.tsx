import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supportsFullAppShellRoutes } from "../../api/app-shell-capabilities";
import { type ComputerUseApprovalSnapshot, client } from "../../api/client";
import { useIsAuthenticated } from "../../hooks/useAuthStatus";
import { useAppSelector } from "../../state";
import { openEventSource } from "../../utils/event-source";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader } from "../ui/card";
import { StatusBadge } from "../ui/status-badge";

const OVERLAY_SHELL_CLASS =
  "fixed inset-0 z-[1002] flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg/75 px-4 py-6 font-body text-txt  sm:px-6";
const OVERLAY_CARD_CLASS =
  "relative z-10 w-full max-w-[820px] overflow-hidden border border-border/60 bg-card/95 ";
const EMPTY_SNAPSHOT: ComputerUseApprovalSnapshot = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
};
const POLL_MS = 1500;
const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

function approvalStreamUrl(): string | null {
  const baseUrl = client.getBaseUrl();
  const restToken = client.getRestAuthToken();
  let url: URL;
  try {
    url = new URL(
      "/api/computer-use/approvals/stream",
      baseUrl || window.location.origin,
    );
  } catch {
    // Non-http native IPC bases (eliza-local-agent://ipc) are not valid URL
    // bases on Android WebView / WebKit — resolving a path against a
    // non-special scheme throws, which crashed the whole shell at boot on
    // on-device builds. EventSource cannot reach those bases anyway, so
    // degrade to the polling path.
    return null;
  }
  if (restToken) {
    url.searchParams.set("token", restToken);
  }
  return url.toString();
}

export function ComputerUseApprovalOverlay() {
  const setActionNotice = useAppSelector((s) => s.setActionNotice);
  const t = useAppSelector((s) => s.t);
  const appShellRoutesSupported = supportsFullAppShellRoutes(
    client.getBaseUrl(),
  );
  // Auth gate (#11084): the shell mounts this overlay before the auth probe
  // resolves, so without this the SSE stream / 1.5s poll fires 401s from every
  // unauthenticated tab. Dormant until the session is authenticated.
  const authenticated = useIsAuthenticated();
  const [snapshot, setSnapshot] =
    useState<ComputerUseApprovalSnapshot>(EMPTY_SNAPSHOT);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);
  const [denyTargetId, setDenyTargetId] = useState<string | null>(null);
  const [denyReason, setDenyReason] = useState("");
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const refresh = useCallback(async () => {
    if (!appShellRoutesSupported || !authenticated) {
      setSnapshot(EMPTY_SNAPSHOT);
      return;
    }
    try {
      setSnapshot(await client.getComputerUseApprovals());
    } catch {
      setSnapshot(EMPTY_SNAPSHOT);
    }
  }, [appShellRoutesSupported, authenticated]);

  useEffect(() => {
    if (!appShellRoutesSupported || !authenticated) {
      setSnapshot(EMPTY_SNAPSHOT);
      return undefined;
    }
    let cancelled = false;
    let pollingTimer: number | null = null;
    let eventSource: EventSource | null = null;

    // Fallback polling (only used when the EventSource stream is unavailable).
    // Skip the network refresh while the document is hidden so a backgrounded
    // window stops hitting /api/computer-use/approvals.
    const pollRefresh = () => {
      if (
        typeof document !== "undefined" &&
        document.visibilityState === "hidden"
      ) {
        return;
      }
      void refresh();
    };
    const startPolling = () => {
      if (pollingTimer !== null) {
        return;
      }
      pollRefresh();
      pollingTimer = window.setInterval(pollRefresh, POLL_MS);
    };

    // On-device runtimes use the native IPC base, which EventSource cannot
    // open; approvalStreamUrl/openEventSource return null there so we fall
    // straight through to polling instead of throwing.
    const streamUrl = approvalStreamUrl();
    eventSource = streamUrl ? openEventSource(streamUrl) : null;
    if (eventSource) {
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
  }, [appShellRoutesSupported, authenticated, refresh]);

  // Defensive: the snapshot can be partially populated during reconnect/
  // recovery windows, so `pendingApprovals` may be momentarily undefined.
  // Never crash the whole app on it — render no cards until it's an array.
  const visibleApprovals = snapshot.pendingApprovals ?? [];
  const approvalCards = useMemo(
    () =>
      visibleApprovals.map((approval) => ({
        ...approval,
        parametersText: JSON.stringify(approval.parameters ?? {}, null, 2),
      })),
    [visibleApprovals],
  );

  // This is a real modal that gates live computer-use actions, so trap focus
  // inside it while it's shown (mirrors AssistantOverlay) — but DO NOT bind
  // Escape: approving/denying is mandatory, there's no dismiss. Restores focus
  // to the prior element when the last approval clears.
  const hasApprovals = approvalCards.length > 0;
  useEffect(() => {
    if (!hasApprovals || typeof document === "undefined") return undefined;
    previousFocusRef.current =
      (document.activeElement as HTMLElement | null) ?? null;
    const dialog = dialogRef.current;
    if (dialog) {
      const firstFocusable =
        dialog.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (firstFocusable ?? dialog).focus();
    }
    function onKey(event: KeyboardEvent): void {
      if (event.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey) {
        if (active === first || active === dialog) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      const previous = previousFocusRef.current;
      if (previous && typeof previous.focus === "function") previous.focus();
      previousFocusRef.current = null;
    };
  }, [hasApprovals]);

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
      ref={dialogRef}
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="computer-use-approval-title"
      tabIndex={-1}
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
                className="rounded-sm border border-border/50 bg-card/75 p-4 "
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
                      {new Date(approval.requestedAt).toLocaleTimeString(
                        "en-US",
                      )}
                    </div>
                    <pre className="mt-4 max-h-56 overflow-auto rounded-sm bg-bg/60 p-3 text-xs leading-relaxed text-txt">
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
                          className="w-full rounded-sm border border-border/60 bg-bg/50 px-3 py-2 text-sm text-txt outline-none"
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
