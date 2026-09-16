/**
 * Compact, inspectable speaker-name decision for live and archived transcript
 * spans. Candidate names remain review metadata unless the shared policy marks
 * the attribution confirmed.
 */

import type {
  SpeakerNameAttribution,
  SpeakerNameEvidenceSource,
} from "@elizaos/shared";
import type * as React from "react";
import { StatusBadge } from "../ui/status-badge";

const SOURCE_LABELS: Record<SpeakerNameEvidenceSource, string> = {
  platform_roster: "roster",
  calendar_attendee: "calendar",
  self_introduction: "self intro",
  user_correction: "correction",
  voice_profile: "voice profile",
  speaker_memory: "speaker memory",
};

function decisionLabel(attribution: SpeakerNameAttribution): string {
  if (attribution.resolution === "confirmed") {
    return attribution.requiresReview ? "Confirmed · review" : "Confirmed";
  }
  if (attribution.resolution === "needs_confirmation") return "Review";
  if (attribution.resolution === "withheld") return "Withheld";
  return "Unknown";
}

function provenanceLabels(attribution: SpeakerNameAttribution): string[] {
  return [
    ...new Set(
      attribution.provenance.map((item) => SOURCE_LABELS[item.source]),
    ),
  ];
}

export function SpeakerNameAttributionBadge({
  attribution,
  className,
}: {
  attribution: SpeakerNameAttribution | null | undefined;
  className?: string;
}): React.JSX.Element | null {
  if (!attribution) return null;
  const decision = decisionLabel(attribution);
  const confidence = Math.round(attribution.confidence * 100);
  const provenance = provenanceLabels(attribution);
  const candidateSummary = attribution.candidateNames
    .map(
      (candidate) =>
        `${candidate.name} (${Math.round(candidate.confidence * 100)}%)`,
    )
    .join(", ");
  const detail = [
    `${decision} speaker identity`,
    `${confidence}% confidence`,
    provenance.length > 0 ? `provenance: ${provenance.join(", ")}` : null,
    candidateSummary ? `candidates: ${candidateSummary}` : null,
  ]
    .filter(Boolean)
    .join("; ");

  return (
    <StatusBadge
      data-testid="speaker-name-attribution"
      data-resolution={attribution.resolution}
      role="note"
      className={className}
      aria-label={detail}
      title={detail}
      tone={attribution.resolution === "confirmed" ? "info" : "muted"}
      label={
        <>
          <span>{decision}</span>
          <span aria-hidden>·</span>
          <span>{confidence}%</span>
          {provenance.length > 0 ? (
            <>
              <span aria-hidden>·</span>
              <span className="truncate">{provenance.join(" + ")}</span>
            </>
          ) : null}
        </>
      }
    />
  );
}
