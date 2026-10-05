/**
 * Privacy controls + data-subject rights, all server-authoritative:
 *   - vision / screen capture, which is governed by device permissions
 *   - a read-only disclosure of the deployment's model-call recording policy
 *     (reported by `/api/v1/me/consents`; recording is deployment
 *     configuration, not a per-user choice)
 *   - live-account data export (`/api/v1/me/data-export`, digest-verified)
 *   - account deletion via the Worker's lifecycle admission state
 */

import { Camera, Download, ScrollText, Trash2 } from "lucide-react";
import { useState } from "react";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { Button } from "../../../components/ui/button";
import { useCloudT } from "../../shell/CloudI18nProvider";
import { useConsents } from "../data/consent-client";
import {
  DataExportTooLargeError,
  downloadAccountDataExport,
  saveExportDownload,
} from "../data/data-export-client";
import { AccountDeletionDialog } from "./account-deletion-dialog";

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : String(error);
}

type ExportState =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "ready" }
  | { kind: "too-large" }
  | { kind: "failed"; message: string };

export function PrivacyPanel() {
  const t = useCloudT();
  const consents = useConsents();
  const [exportState, setExportState] = useState<ExportState>({
    kind: "idle",
  });

  const recording = consents.data?.capture.modelCallRecording;

  const onExport = async () => {
    setExportState({ kind: "pending" });
    try {
      await saveExportDownload(await downloadAccountDataExport());
      setExportState({ kind: "ready" });
    } catch (error) {
      // error-policy:J4 export failure stays visible and never presents a
      // download as successful.
      setExportState(
        error instanceof DataExportTooLargeError
          ? { kind: "too-large" }
          : { kind: "failed", message: errorMessage(error) },
      );
    }
  };

  const consentStatus = consents.isError ? (
    <SettingsRow
      label={t("cloud.privacyPanel.consentsLoadFailed", {
        defaultValue: "Couldn't load your privacy choices.",
      })}
      description={errorMessage(consents.error)}
      control={
        <Button
          size="sm"
          variant="outline"
          data-testid="privacy-consents-retry"
          onClick={() => void consents.refetch()}
        >
          {t("common.retry", { defaultValue: "Retry" })}
        </Button>
      }
    />
  ) : consents.isPending ? (
    <SettingsRow
      label={t("cloud.privacyPanel.consentsLoading", {
        defaultValue: "Loading your privacy choices…",
      })}
    />
  ) : null;

  const recordingRow = recording ? (
    <SettingsRow
      icon={ScrollText}
      label={t("cloud.privacyPanel.recordingTitle", {
        defaultValue: "Model-call recording",
      })}
      description={
        <span
          data-testid="model-call-recording-status"
          data-state={recording.enabled ? "on" : "off"}
        >
          {recording.enabled
            ? t("cloud.privacyPanel.recordingOn", {
                defaultValue:
                  "This deployment records model calls to improve Eliza. Recordings are encrypted and deleted after {{days}} days.",
                days: recording.retentionDays,
              })
            : t("cloud.privacyPanel.recordingOff", {
                defaultValue: "Model-call recording is off on this deployment.",
              })}
        </span>
      }
    />
  ) : null;

  return (
    <SettingsStack data-testid="cloud-privacy-panel">
      <SettingsGroup
        title={t("cloud.privacyPanel.title", { defaultValue: "Privacy" })}
        description={t("cloud.privacyPanel.subtitle", {
          defaultValue:
            "Control optional data capture and exercise your data rights.",
        })}
      >
        {consentStatus}
        <SettingsRow
          icon={Camera}
          label={t("cloud.privacyPanel.visionPermissionsTitle", {
            defaultValue: "Vision and screen capture",
          })}
          description={t("cloud.privacyPanel.visionPermissionsDescription", {
            defaultValue:
              "Manage camera and screen capture through your device permissions. Account-wide capture controls are not available yet.",
          })}
        />
        {recordingRow}
        <SettingsRow
          icon={Download}
          label={t("cloud.privacyPanel.downloadTitle", {
            defaultValue: "Download my data",
          })}
          description={
            <>
              {t("cloud.privacyPanel.downloadAccountDescription", {
                defaultValue:
                  "Download a JSON archive of records owned by your account. Organization-wide records are excluded. Secrets and credentials are redacted.",
              })}
              {exportState.kind === "ready" ? (
                <span role="status" className="block">
                  {t("cloud.privacyPanel.exportReady", {
                    defaultValue:
                      "Export ready — your download should start automatically.",
                  })}
                </span>
              ) : null}
              {exportState.kind === "too-large" ? (
                <span role="alert" className="block text-danger">
                  {t("cloud.privacyPanel.exportTooLarge", {
                    defaultValue:
                      "Your data is larger than the self-service export limit. Contact support to request a full export.",
                  })}
                </span>
              ) : null}
              {exportState.kind === "failed" ? (
                <span role="alert" className="block text-danger">
                  {t("cloud.privacyPanel.exportFailed", {
                    defaultValue: "Export failed: {{message}}",
                    message: exportState.message,
                  })}
                </span>
              ) : null}
            </>
          }
          stacked
        >
          <Button
            size="sm"
            variant="outline"
            data-testid="privacy-export-button"
            disabled={exportState.kind === "pending"}
            onClick={() => void onExport()}
          >
            {exportState.kind === "pending"
              ? t("cloud.privacyPanel.exportPreparing", {
                  defaultValue: "Preparing…",
                })
              : t("cloud.privacyPanel.export", { defaultValue: "Export" })}
          </Button>
        </SettingsRow>
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
          stacked
        >
          <AccountDeletionDialog />
        </SettingsRow>
      </SettingsGroup>
    </SettingsStack>
  );
}
