import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  BrandButton,
  BrandCard,
  CornerBrackets,
  Input,
  Switch,
} from "@elizaos/ui";
import { Camera, Download, ScrollText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/api-client";
import { emitAuditEvent } from "@/lib/security/audit-client";
import {
  getTrajectoryLoggingEnabled,
  getVisionEnabled,
  setTrajectoryLoggingEnabled,
  setVisionEnabled,
} from "@/lib/security/consent-store";
import { useT } from "@/providers/I18nProvider";

const DELETE_CONFIRM_PHRASE = "delete my account";

export function PrivacyPanel() {
  const t = useT();
  const [vision, setVision] = useState(false);
  const [trajectory, setTrajectory] = useState(false);
  useEffect(() => {
    setVision(getVisionEnabled());
    setTrajectory(getTrajectoryLoggingEnabled());
  }, []);

  const onVisionChange = (next: boolean) => {
    setVisionEnabled(next);
    setVision(next);
    void emitAuditEvent({
      action: next ? "vision.allowed" : "vision.denied",
      result: "allow",
      metadata: { reason: "user.toggle" },
    });
  };

  const onTrajectoryChange = (next: boolean) => {
    setTrajectoryLoggingEnabled(next);
    setTrajectory(next);
  };

  const exportData = async () => {
    try {
      const res = await apiFetch("/api/v1/me/export", { method: "GET" });
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `eliza-data-export-${new Date()
        .toISOString()
        .replace(/[:.]/g, "-")}.zip`;
      a.click();
      URL.revokeObjectURL(url);
      void emitAuditEvent({
        action: "data.export",
        result: "allow",
        metadata: { scope: "all" },
      });
      toast.success(
        t("cloud.privacyPanel.exportReady", {
          defaultValue:
            "Export ready — your download should start automatically.",
        }),
      );
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.info(
          t("cloud.privacyPanel.exportComingSoon", {
            defaultValue:
              "Data export is coming soon — not yet available on this server.",
          }),
        );
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        t("cloud.privacyPanel.exportFailed", {
          message,
          defaultValue: "Export failed: {{message}}",
        }),
      );
    }
  };

  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);

  const deleteAccount = async () => {
    if (deleteConfirmText.trim().toLowerCase() !== DELETE_CONFIRM_PHRASE) {
      toast.error(
        t("cloud.privacyPanel.confirmPhrasePrompt", {
          phrase: DELETE_CONFIRM_PHRASE,
          defaultValue: 'Please type "{{phrase}}" to confirm.',
        }),
      );
      return;
    }
    setDeleteSubmitting(true);
    try {
      await apiFetch("/api/v1/me/delete-request", { method: "POST" });
      void emitAuditEvent({
        action: "data.delete_request",
        result: "allow",
        metadata: { scope: "account" },
      });
      toast.success(
        t("cloud.privacyPanel.deletionScheduled", {
          defaultValue:
            "Deletion scheduled. You have 30 days to recover before purge.",
        }),
      );
      setDeleteOpen(false);
      setDeleteConfirmText("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        toast.info(
          t("cloud.privacyPanel.deletionComingSoon", {
            defaultValue:
              "Account deletion is coming soon — not yet available on this server.",
          }),
        );
        setDeleteOpen(false);
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        t("cloud.privacyPanel.deleteRequestFailed", {
          message,
          defaultValue: "Delete request failed: {{message}}",
        }),
      );
    } finally {
      setDeleteSubmitting(false);
    }
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-white">
            {t("cloud.privacyPanel.title", { defaultValue: "Privacy" })}
          </h3>
          <p className="text-sm text-white/60">
            {t("cloud.privacyPanel.subtitle", {
              defaultValue:
                "Control optional data capture and exercise your data rights.",
            })}
          </p>
        </div>

        {/* Vision toggle */}
        <div className="flex items-start justify-between gap-3 rounded-sm border border-white/10 bg-black/40 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-purple-500/40 bg-purple-500/20 p-2">
              <Camera className="h-4 w-4 text-purple-300" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-white">
                {t("cloud.privacyPanel.visionTitle", {
                  defaultValue: "Allow vision / screen capture",
                })}
              </p>
              <p className="text-xs text-white/60">
                {t("cloud.privacyPanel.visionDescription", {
                  defaultValue:
                    "Off by default. When on, plugins may request screen frames or webcam capture. Remote models charge per image — review your model's per-call fee in Settings → Billing before enabling.",
                })}
              </p>
            </div>
          </div>
          <Switch
            checked={vision}
            onCheckedChange={onVisionChange}
            data-testid="vision-toggle"
          />
        </div>

        {/* Trajectory logging toggle */}
        <div className="flex items-start justify-between gap-3 rounded-sm border border-white/10 bg-black/40 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-[#FF5800]/40 bg-[#FF5800]/15 p-2">
              <ScrollText className="h-4 w-4 text-[#FF5800]" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-white">
                {t("cloud.privacyPanel.trajectoryTitle", {
                  defaultValue: "Trajectory logging",
                })}
              </p>
              <p className="text-xs text-white/60">
                {t("cloud.privacyPanel.trajectoryDescription", {
                  defaultValue:
                    "Off by default. When on, Eliza records per-step plan/action traces locally with a 30-day retention. Redacted content is marked separately from raw.",
                })}
              </p>
            </div>
          </div>
          <Switch
            checked={trajectory}
            onCheckedChange={onTrajectoryChange}
            data-testid="trajectory-toggle"
          />
        </div>

        {/* DSR — Export */}
        <div className="flex items-start justify-between gap-3 rounded-sm border border-white/10 bg-black/40 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-green-500/40 bg-green-500/20 p-2">
              <Download className="h-4 w-4 text-green-300" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-white">
                {t("cloud.privacyPanel.downloadTitle", {
                  defaultValue: "Download my data",
                })}
              </p>
              <p className="text-xs text-white/60">
                {t("cloud.privacyPanel.downloadDescription", {
                  defaultValue:
                    "Bundle your conversations, agents, and connector data into a portable archive (GDPR / CCPA right-to-export).",
                })}
              </p>
            </div>
          </div>
          <BrandButton
            size="sm"
            variant="outline"
            onClick={() => void exportData()}
          >
            {t("cloud.privacyPanel.export", { defaultValue: "Export" })}
          </BrandButton>
        </div>

        {/* DSR — Delete */}
        <div className="flex items-start justify-between gap-3 rounded-sm border border-red-500/30 bg-red-500/5 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-red-500/40 bg-red-500/20 p-2">
              <Trash2 className="h-4 w-4 text-red-300" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-white">
                {t("cloud.privacyPanel.deleteTitle", {
                  defaultValue: "Delete my account",
                })}
              </p>
              <p className="text-xs text-white/60">
                {t("cloud.privacyPanel.deleteDescription", {
                  defaultValue:
                    "Schedules a 30-day soft-delete. You can sign back in during the window to cancel. After 30 days, all data is purged.",
                })}
              </p>
            </div>
          </div>
          <BrandButton
            size="sm"
            variant="outline"
            className="border-red-500/40 text-red-300"
            onClick={() => setDeleteOpen(true)}
            data-testid="delete-account-trigger"
          >
            {t("cloud.privacyPanel.deleteAccount", {
              defaultValue: "Delete account…",
            })}
          </BrandButton>
        </div>
      </div>

      <AlertDialog
        open={deleteOpen}
        onOpenChange={(next) => {
          if (!next) setDeleteConfirmText("");
          setDeleteOpen(next);
        }}
      >
        <AlertDialogContent data-testid="delete-account-dialog">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("cloud.privacyPanel.dialogTitle", {
                defaultValue: "Delete your account?",
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("cloud.privacyPanel.dialogIntro", {
                defaultValue:
                  "We'll keep your data for 30 days in case you change your mind. To confirm, type",
              })}{" "}
              <code>{DELETE_CONFIRM_PHRASE}</code>{" "}
              {t("cloud.privacyPanel.dialogBelow", {
                defaultValue: "below.",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Input
            value={deleteConfirmText}
            onChange={(e) => setDeleteConfirmText(e.target.value)}
            placeholder={DELETE_CONFIRM_PHRASE}
            data-testid="delete-account-confirm-input"
          />
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteSubmitting}>
              {t("cloud.privacyPanel.cancel", { defaultValue: "Cancel" })}
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={
                deleteSubmitting ||
                deleteConfirmText.trim().toLowerCase() !== DELETE_CONFIRM_PHRASE
              }
              onClick={(e) => {
                e.preventDefault();
                void deleteAccount();
              }}
              data-testid="delete-account-confirm"
            >
              {deleteSubmitting
                ? t("cloud.privacyPanel.submitting", {
                    defaultValue: "Submitting…",
                  })
                : t("cloud.privacyPanel.scheduleDeletion", {
                    defaultValue: "Schedule deletion",
                  })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </BrandCard>
  );
}
