import { BrandButton, BrandCard, CornerBrackets, Textarea } from "@elizaos/ui";
import { useState } from "react";
import { toast } from "sonner";
import { ApiError, apiFetch } from "@/lib/api-client";

export function IncidentReportPanel() {
  const [details, setDetails] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!details.trim()) {
      toast.error("Please describe what happened.");
      return;
    }
    setSubmitting(true);
    try {
      await apiFetch("/api/v1/security/incident", {
        method: "POST",
        json: { details: details.trim() },
      });
      toast.success("Incident report submitted. We'll follow up by email.");
      setDetails("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        // Server endpoint not built yet — fall back to mailto.
        const mailto = `mailto:security@elizalabs.ai?subject=${encodeURIComponent(
          "Security incident report",
        )}&body=${encodeURIComponent(details.trim())}`;
        window.location.href = mailto;
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to submit: ${message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <BrandCard className="relative">
      <CornerBrackets size="sm" className="opacity-50" />
      <div className="relative z-10 space-y-3">
        <div>
          <h3 className="text-lg font-bold text-white">
            Report a security incident
          </h3>
          <p className="text-sm text-white/60">
            Email{" "}
            <a
              href="mailto:security@elizalabs.ai"
              className="text-[#FF5800] underline"
            >
              security@elizalabs.ai
            </a>{" "}
            or submit details below. Encrypted disclosures welcomed.
          </p>
        </div>
        <Textarea
          value={details}
          onChange={(e) => setDetails(e.target.value)}
          placeholder="What happened? Include affected URLs, timestamps, and steps to reproduce."
          rows={5}
          disabled={submitting}
        />
        <BrandButton
          size="sm"
          variant="primary"
          onClick={() => void submit()}
          disabled={submitting}
        >
          {submitting ? "Submitting…" : "Submit incident report"}
        </BrandButton>
      </div>
    </BrandCard>
  );
}
