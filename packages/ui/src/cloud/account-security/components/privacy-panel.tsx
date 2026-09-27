/**
 * Privacy controls + data-subject rights, all server-authoritative:
 *   - vision / screen-capture consent (`/api/v1/me/consents`, default off)
 *   - model-call training consent (`/api/v1/me/consents`; with no recorded
 *     choice the Cloud default of capture applies, and the copy says so)
 *   - live-account data export (`/api/v1/me/data-export`, digest-verified)
 *   - account deletion via the Worker's lifecycle admission state
 *
 * The server records each consent change and emits its audit event; this panel
 * only renders the receipts and never keeps consent in browser storage.
 */

import { Camera, Download, ScrollText, Trash2 } from "lucide-react";
import { useState } from "react";
import { SettingsSwitchRow } from "../../../components/settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsRow,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { Button } from "../../../components/ui/button";
import { useCloudT } from "../../shell/CloudI18nProvider";
import {
  type ConsentPurpose,
  useConsents,
  useRecordConsent,
} from "../data/consent-client";
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
  const recordConsent = useRecordConsent();
  const [pendingPurpose, setPendingPurpose] = useState<ConsentPurpose | null>(
    null,
  );
  const [exportState, setExportState] = useState<ExportState>({
    kind: "idle",
  });

  const loaded = consents.isSuccess;
  const vision = consents.data?.vision_capture;
  const trajectory = consents.data?.trajectory_training;
  // Vision capture is opt-in. Training capture follows the Cloud default
  // (capture) until the user records a choice; the description states this.
  const visionChecked = vision?.granted ?? false;
  const trajectoryChecked = trajectory?.granted ?? true;

  const onConsentChange = (purpose: ConsentPurpose, granted: boolean) => {
    setPendingPurpose(purpose);
    recordConsent.mutate(
      { purpose, granted },
      { onSettled: () => setPendingPurpose(null) },
    );
  };

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

  const trajectoryDescription = (
    <>
      {t("cloud.privacyPanel.trainingDescription", {
        defaultValue:
          "Eliza Cloud keeps the prompts and responses of model calls billed to your account and may use them to improve models. Turn off to opt out of that capture.",
      })}
      {loaded && !trajectory ? (
        <>
          {" "}
          {t("cloud.privacyPanel.trainingNoChoice", {
            defaultValue:
              "You haven't chosen yet, so the Cloud default (on) applies.",
          })}
        </>
      ) : null}
    </>
  );

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
        <SettingsSwitchRow
          agentId="cloud-privacy-vision"
          group="cloud-privacy"
          icon={Camera}
          testId="vision-toggle"
          label={t("cloud.privacyPanel.visionTitle", {
            defaultValue: "Allow vision / screen capture",
          })}
          description={t("cloud.privacyPanel.visionConsentDescription", {
            defaultValue:
              "Off unless you turn it on. Your choice is saved to your Eliza Cloud account; screen and camera capture still ask for device permission. Remote models charge per image — check Settings → Billing first.",
          })}
          checked={visionChecked}
          disabled={!loaded || pendingPurpose !== null}
          onCheckedChange={(next) => onConsentChange("vision_capture", next)}
        />
        <SettingsSwitchRow
          agentId="cloud-privacy-trajectory"
          group="cloud-privacy"
          icon={ScrollText}
          testId="trajectory-toggle"
          label={t("cloud.privacyPanel.trainingTitle", {
            defaultValue: "Use my model calls for training",
          })}
          description={trajectoryDescription}
          checked={trajectoryChecked}
          disabled={!loaded || pendingPurpose !== null}
          onCheckedChange={(next) =>
            onConsentChange("trajectory_training", next)
          }
        />
        {recordConsent.isError ? (
          <p
            role="alert"
            data-testid="privacy-consent-error"
            className="px-4 py-2 text-sm text-danger"
          >
            {t("cloud.privacyPanel.consentSaveFailed", {
              defaultValue: "Couldn't save your choice: {{message}}",
              message: errorMessage(recordConsent.error),
            })}
          </p>
        ) : null}
        <SettingsRow
          icon={Download}
          label={t("cloud.privacyPanel.downloadTitle", {
            defaultValue: "Download my data",
          })}
          description={
            <>
              {t("cloud.privacyPanel.downloadAccountDescription", {
                defaultValue:
                  "Download a JSON archive of the records linked to your account and organization. Secrets and credentials are redacted.",
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
          control={
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
