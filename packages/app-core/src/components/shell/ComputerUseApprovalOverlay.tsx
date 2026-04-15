import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  StatusBadge,
} from "@elizaos/ui";
import { client, type ComputerUseApprovalSnapshot } from "../../api/client";
import { useApp } from "../../state";

const OVERLAY_SHELL_CLASS =
  "fixed inset-0 z-[1002] flex min-h-screen w-full items-center justify-center overflow-hidden bg-bg/75 px-4 py-6 font-body text-txt backdrop-blur-sm sm:px-6";
const OVERLAY_CARD_CLASS =
  "relative z-10 w-full max-w-[720px] overflow-hidden border border-border/60 bg-card/95 shadow-[0_30px_120px_rgba(0,0,0,0.36)] backdrop-blur-xl";
const EMPTY_SNAPSHOT: ComputerUseApprovalSnapshot = {
  mode: "full_control",
  pendingCount: 0,
  pendingApprovals: [],
};
const POLL_MS = 1500;

export function ComputerUseApprovalOverlay() {
  const { setActionNotice, t } = useApp();
  const [snapshot, setSnapshot] =
    useState<ComputerUseApprovalSnapshot>(EMPTY_SNAPSHOT);
  const [busyApprovalId, setBusyApprovalId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await client.getComputerUseApprovals();
      setSnapshot(next);
    } catch {
      setSnapshot(EMPTY_SNAPSHOT);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const intervalId = window.setInterval(() => {
      void refresh();
    }, POLL_MS);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [refresh]);

  const currentApproval = snapshot.pendingApprovals[0] ?? null;
  const queuedCount = Math.max(0, snapshot.pendingCount - 1);
  const parametersText = useMemo(
    () =>
      currentApproval
        ? JSON.stringify(currentApproval.parameters ?? {}, null, 2)
        : "",
    [currentApproval],
  );

  const handleRespond = useCallback(
    async (approved: boolean) => {
      if (!currentApproval || busyApprovalId) {
        return;
      }

      setBusyApprovalId(currentApproval.id);
      try {
        const resolution = await client.respondToComputerUseApproval(
          currentApproval.id,
          approved,
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
    [busyApprovalId, currentApproval, refresh, setActionNotice, t],
  );

  if (!currentApproval) {
    return null;
  }

  const busy = busyApprovalId === currentApproval.id;

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
                  defaultValue: "Allow this computer action?",
                })}
              </h1>
              <CardDescription className="max-w-[58ch] leading-relaxed">
                {t("computeruseapprovaloverlay.Body", {
                  defaultValue:
                    "The agent requested a local computer-use action that requires approval before it runs.",
                })}
              </CardDescription>
            </div>
          </div>
        </CardHeader>

        <CardContent className="flex flex-col gap-5 pt-6">
          <div className="rounded-2xl border border-border/50 bg-bg/35 p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
              {t("computeruseapprovaloverlay.Command", {
                defaultValue: "Command",
              })}
            </div>
            <div className="mt-2 break-all text-sm font-medium text-txt">
              {currentApproval.command}
            </div>
            <div className="mt-3 text-xs text-muted">
              {t("computeruseapprovaloverlay.ModeLine", {
                defaultValue:
                  "Approval mode: {{mode}}. Requested at {{time}}.",
                mode: snapshot.mode,
                time: new Date(currentApproval.requestedAt).toLocaleTimeString(),
              })}
            </div>
            {queuedCount > 0 ? (
              <div className="mt-2 text-xs text-muted">
                {t("computeruseapprovaloverlay.QueueNotice", {
                  defaultValue:
                    "{{count}} more computer-use approval(s) are waiting.",
                  count: String(queuedCount),
                })}
              </div>
            ) : null}
          </div>

          <div className="rounded-2xl border border-border/50 bg-card/70 p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-[0.2em] text-muted">
              {t("computeruseapprovaloverlay.Parameters", {
                defaultValue: "Parameters",
              })}
            </div>
            <pre className="mt-3 max-h-64 overflow-auto rounded-xl bg-bg/60 p-3 text-xs leading-relaxed text-txt">
              {parametersText || "{}"}
            </pre>
          </div>

          <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-end">
            <Button
              variant="outline"
              size="lg"
              disabled={busy}
              onClick={() => {
                void handleRespond(false);
              }}
              className="w-full sm:w-auto sm:min-w-[10rem]"
            >
              {busy
                ? t("computeruseapprovaloverlay.Resolving", {
                    defaultValue: "Resolving...",
                  })
                : t("computeruseapprovaloverlay.Reject", {
                    defaultValue: "Reject",
                  })}
            </Button>
            <Button
              variant="default"
              size="lg"
              disabled={busy}
              onClick={() => {
                void handleRespond(true);
              }}
              className="w-full sm:w-auto sm:min-w-[10rem]"
            >
              {busy
                ? t("computeruseapprovaloverlay.Resolving", {
                    defaultValue: "Resolving...",
                  })
                : t("computeruseapprovaloverlay.Approve", {
                    defaultValue: "Approve",
                  })}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
