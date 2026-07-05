/**
 * Report a security incident: POST /api/v1/security/incident, falling back to a
 * mailto: when the endpoint isn't built yet.
 */

import { useState } from "react";
import { toast } from "sonner";
import {
  BrandButton,
  BrandCard,
  CornerBrackets,
  Textarea,
} from "../../../cloud-ui";
import { ApiError, apiFetch } from "../../lib/api-client";
import { useCloudT } from "../../shell/CloudI18nProvider";

const SECURITY_EMAIL = "security@elizaos.ai";

export function IncidentReportPanel() {
  const t = useCloudT();
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

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
        // Server endpoint not built yet — fall back to mailto.
        const mailto = `mailto:${SECURITY_EMAIL}?subject=${encodeURIComponent(
          "Security incident report",
        )}&body=${encodeURIComponent(details.trim())}`;
        window.location.href = mailto;
        return;
      }
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
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div>
          <h3 className="text-lg font-bold text-txt-strong">
            {t("cloud.incidentReport.title", {
              defaultValue: "Report a security incident",
            })}
          </h3>
          <p className="text-sm text-muted">
            {t("cloud.incidentReport.emailPre", { defaultValue: "Email" })}{" "}
            <a
              href={`mailto:${SECURITY_EMAIL}`}
              className="text-[var(--brand-orange)] underline"
            >
              {SECURITY_EMAIL}
            </a>{" "}
            {t("cloud.incidentReport.emailPost", {
              defaultValue:
                "or submit details below. Encrypted disclosures welcomed.",
            })}
          </p>
        </div>
        <Textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder={t("cloud.incidentReport.placeholder", {
            defaultValue:
              "What happened? Include affected URLs, timestamps, and steps to reproduce.",
          })}
          rows={5}
          disabled={submitting}
        />
        <BrandButton
          size="sm"
          variant="primary"
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting
            ? t("cloud.incidentReport.submitting", {
                defaultValue: "Submitting…",
              })
            : t("cloud.incidentReport.submit", {
                defaultValue: "Submit incident report",
              })}
        </BrandButton>
      </div>
    </BrandCard>
  );
}
