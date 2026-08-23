/**
 * Privacy controls + data-subject rights:
 *   - vision / screen-capture consent toggle (local consent store)
 *   - trajectory logging toggle (local consent store)
 *
 * Account deletion renders the Worker's read-only lifecycle admission state.
 * Data export remains visible but unavailable until its export job ships.
 */

import { Camera, Download, ScrollText, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { SettingsSwitchRow } from "../../../components/settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { Button } from "../../../components/ui/button";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { emitAuditEvent } from "../data/audit-client";
import {
  getTrajectoryLoggingEnabled,
  getVisionEnabled,
  setTrajectoryLoggingEnabled,
  setVisionEnabled,
} from "../data/consent-store";
import { AccountDeletionDialog } from "./account-deletion-dialog";

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
    <SettingsStack data-testid="cloud-privacy-panel">
      <SettingsGroup
        title={t("cloud.privacyPanel.title", { defaultValue: "Privacy" })}
        description={t("cloud.privacyPanel.subtitle", {
          defaultValue:
            "Control optional data capture and exercise your data rights.",
        })}
      >
        <SettingsSwitchRow
          agentId="cloud-privacy-vision"
          group="cloud-privacy"
          icon={Camera}
          testId="vision-toggle"
          label={t("cloud.privacyPanel.visionTitle", {
            defaultValue: "Allow vision / screen capture",
          })}
          description={t("cloud.privacyPanel.visionDescription", {
            defaultValue:
              "Off by default. When on, plugins may request screen frames or webcam capture. Remote models charge per image — review your model's per-call fee in Settings → Billing before enabling.",
          })}
          checked={vision}
          onCheckedChange={onVisionChange}
        />
        <SettingsSwitchRow
          agentId="cloud-privacy-trajectory"
          group="cloud-privacy"
          icon={ScrollText}
          testId="trajectory-toggle"
          label={t("cloud.privacyPanel.trajectoryTitle", {
            defaultValue: "Trajectory logging",
          })}
          description={t("cloud.privacyPanel.trajectoryDescription", {
            defaultValue:
              "Off by default. When on, Eliza records per-step plan/action traces locally with a 30-day retention. Redacted content is marked separately from raw.",
          })}
          checked={trajectory}
          onCheckedChange={onTrajectoryChange}
        />
        <SettingsRow
          icon={Download}
          label={t("cloud.privacyPanel.downloadTitle", {
            defaultValue: "Download my data",
          })}
          description={t("cloud.privacyPanel.downloadDescription", {
            defaultValue:
              "Bundle your conversations, agents, and connector data into a portable archive (GDPR / CCPA right-to-export).",
          })}
          control={
            <Button
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
            </Button>
          }
        />
        <SettingsRow
          icon={Trash2}
          tone="danger"
          label={t("cloud.privacyPanel.deleteTitle", {
            defaultValue: "Delete my account",
          })}
          description={t("cloud.privacyPanel.deleteAvailabilityDescription", {
            defaultValue:
              "Checks whether the verified account-deletion lifecycle is available. Shared resources may need transfer first; unavailable requests are routed to support without changing your account.",
          })}
          control={<AccountDeletionDialog />}
        />
      </SettingsGroup>
    </SettingsStack>
  );
}
