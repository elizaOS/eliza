/**
 * Privacy controls + data-subject rights:
 *   - vision / screen-capture consent toggle (local consent store)
 *   - trajectory logging toggle (local consent store)
 *
 * DSR export/deletion jobs are not exposed by the Worker yet. Keep those
 * controls visible but disabled so the launch surface does not issue dead
 * `/api/v1/me/*` calls or imply a request was scheduled.
 */

import { Camera, Download, ScrollText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import {
  BrandButton,
  BrandCard,
  CornerBrackets,
  Switch,
} from "../../../cloud-ui";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { emitAuditEvent } from "../data/audit-client";
import {
  getTrajectoryLoggingEnabled,
  getVisionEnabled,
  setTrajectoryLoggingEnabled,
  setVisionEnabled,
} from "../data/consent-store";

export function PrivacyPanel() {
  const t = useCloudT();
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

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-4">
        <div>
          <h3 className="text-lg font-bold text-txt-strong">
            {t("cloud.privacyPanel.title", { defaultValue: "Privacy" })}
          </h3>
          <p className="text-sm text-muted">
            {t("cloud.privacyPanel.subtitle", {
              defaultValue:
                "Control optional data capture and exercise your data rights.",
            })}
          </p>
        </div>

        {/* Vision toggle */}
        <div className="flex items-start justify-between gap-3 rounded-sm border border-border bg-surface p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-purple-500/40 bg-purple-500/20 p-2">
              <Camera className="h-4 w-4 text-purple-300" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-txt-strong">
                {t("cloud.privacyPanel.visionTitle", {
                  defaultValue: "Allow vision / screen capture",
                })}
              </p>
              <p className="text-xs text-muted">
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
        <div className="flex items-start justify-between gap-3 rounded-sm border border-border bg-surface p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-border bg-muted p-2">
              <ScrollText className="h-4 w-4 text-muted" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-txt-strong">
                {t("cloud.privacyPanel.trajectoryTitle", {
                  defaultValue: "Trajectory logging",
                })}
              </p>
              <p className="text-xs text-muted">
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
        <div className="flex items-start justify-between gap-3 rounded-sm border border-border bg-surface p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-green-500/40 bg-green-500/20 p-2">
              <Download className="h-4 w-4 text-green-700 dark:text-green-300" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-txt-strong">
                {t("cloud.privacyPanel.downloadTitle", {
                  defaultValue: "Download my data",
                })}
              </p>
              <p className="text-xs text-muted">
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
            disabled
            title={t("cloud.privacyPanel.exportComingSoon", {
              defaultValue:
                "Data export is coming soon — not yet available on this server.",
            })}
          >
            {t("cloud.privacyPanel.exportUnavailable", {
              defaultValue: "Export unavailable",
            })}
          </BrandButton>
        </div>

        {/* DSR — Delete */}
        <div className="flex items-start justify-between gap-3 rounded-sm border border-red-500/30 bg-red-500/5 p-4">
          <div className="flex items-start gap-3">
            <div className="rounded-sm border border-red-500/40 bg-red-500/20 p-2">
              <Trash2 className="h-4 w-4 text-red-600 dark:text-red-300" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium text-txt-strong">
                {t("cloud.privacyPanel.deleteTitle", {
                  defaultValue: "Delete my account",
                })}
              </p>
              <p className="text-xs text-muted">
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
            className="border-red-500/40 text-red-600 dark:text-red-300"
            disabled
            title={t("cloud.privacyPanel.deletionComingSoon", {
              defaultValue:
                "Account deletion is coming soon — not yet available on this server.",
            })}
            data-testid="delete-account-trigger"
          >
            {t("cloud.privacyPanel.deleteUnavailable", {
              defaultValue: "Deletion unavailable",
            })}
          </BrandButton>
        </div>
      </div>
    </BrandCard>
  );
}
