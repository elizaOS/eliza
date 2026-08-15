/**
 * Security incident report form. POSTs /api/v1/security/incident and falls
 * back to mailto:security@elizaos.ai when that route is not shipped. Mounted
 * on the cloud-security settings section as a labelled SettingsTextareaRow.
 */

import { useState } from "react";
import { toast } from "sonner";
import {
  SettingsActionButton,
  SettingsTextareaRow,
} from "../../../components/settings/settings-agent-rows";
import {
  SettingsGroup,
  SettingsStack,
} from "../../../components/settings/settings-layout";
import { ApiError, apiFetch } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

const SECURITY_EMAIL = "security@elizaos.ai";

export function IncidentReportPanel() {
  const t = useCloudT();
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const submitLabel = submitting
    ? t("cloud.incidentReport.submitting", {
        defaultValue: "Submitting…",
      })
    : t("cloud.incidentReport.submit", {
        defaultValue: "Submit incident report",
      });

  const submit = async () => {
    if (!details.trim()) {
      toast.error(
        t("cloud.incidentReport.describeWhatHappened", {
          defaultValue: "Please describe what happened.",
        }),
      );
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/v1/security/incident", {
        method: "POST",
        json: { details: details.trim() },
      });
      toast.success(
        t("cloud.incidentReport.submittedSuccess", {
          defaultValue: "Incident report submitted. We'll follow up by email.",
        }),
      );
      setDetails("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // error-policy:J4 endpoint not shipped; open mailto instead of a fake success
        const mailto = `mailto:${SECURITY_EMAIL}?subject=${encodeURIComponent(
          "Security incident report",
        )}&body=${encodeURIComponent(details.trim())}`;
        window.location.href = mailto;
        return;
      }
      // error-policy:J4 surface submit failure as a toast, not a fabricated success
      const message = err instanceof Error ? err.message : String(err);
      toast.error(
        t("cloud.incidentReport.failedToSubmit", {
          message,
          defaultValue: "Failed to submit: {{message}}",
        }),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <SettingsStack data-testid="cloud-incident-report">
      <SettingsGroup
        title={t("cloud.incidentReport.title", {
          defaultValue: "Report a security incident",
        })}
        description={
          <>
            {t("cloud.incidentReport.emailPre", { defaultValue: "Email" })}{" "}
            <a
              href={`mailto:${SECURITY_EMAIL}`}
              className="text-txt-strong underline"
            >
              {SECURITY_EMAIL}
            </a>{" "}
            {t("cloud.incidentReport.emailPost", {
              defaultValue:
                "or submit details below. Encrypted disclosures welcomed.",
            })}
          </>
        }
      >
        <SettingsTextareaRow
          agentId="cloud-incident-details"
          group="cloud-incident"
          label={t("cloud.incidentReport.detailsLabel", {
            defaultValue: "Incident details",
          })}
          value={details}
          onValueChange={setDetails}
          placeholder={t("cloud.incidentReport.placeholder", {
            defaultValue:
              "What happened? Include affected URLs, timestamps, and steps to reproduce.",
          })}
          rows={5}
          disabled={submitting}
          textareaClassName="block w-full resize-y font-sans text-sm text-txt"
        />
        <div className="pt-1">
          <SettingsActionButton
            agentId="cloud-incident-submit"
            agentGroup="cloud-incident"
            agentLabel={submitLabel}
            type="button"
            variant="default"
            disabled={submitting}
            onClick={() => void submit()}
            className="h-11 w-full rounded-md px-4 text-sm sm:w-fit"
          >
            {submitLabel}
          </SettingsActionButton>
        </div>
      </SettingsGroup>
    </SettingsStack>
  );
}
