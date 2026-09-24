/**
 * Renders confirmed and withheld speaker-name decisions in jsdom, including
 * confidence/provenance while keeping unconfirmed candidate names out of the
 * visible transcript label.
 */

// @vitest-environment jsdom

import type { SpeakerNameAttribution } from "@elizaos/shared";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SpeakerNameAttributionBadge } from "./SpeakerNameAttributionBadge";

afterEach(cleanup);

function attribution(
  overrides: Partial<SpeakerNameAttribution> = {},
): SpeakerNameAttribution {
  return {
    resolution: "confirmed",
    displayName: "Alice Chen",
    confidence: 0.9,
    candidateNames: [
      {
        name: "Alice Chen",
        normalizedName: "alice chen",
        confidence: 0.9,
        sources: ["platform_roster", "calendar_attendee"],
        provenance: [
          { source: "platform_roster", confidence: 0.9 },
          { source: "calendar_attendee", confidence: 0.82 },
        ],
      },
    ],
    provenance: [
      { source: "platform_roster", confidence: 0.9 },
      { source: "calendar_attendee", confidence: 0.82 },
    ],
    reasonCodes: ["source_agreement", "high_confidence_name"],
    requiresReview: false,
    ...overrides,
  };
}

describe("SpeakerNameAttributionBadge", () => {
  it("shows confirmed confidence and provenance", () => {
    render(<SpeakerNameAttributionBadge attribution={attribution()} />);
    const badge = screen.getByTestId("speaker-name-attribution");
    expect(badge.textContent).toContain("Confirmed");
    expect(badge.textContent).toContain("90%");
    expect(badge.textContent).toContain("roster + calendar");
    expect(badge.getAttribute("data-resolution")).toBe("confirmed");
  });

  it("shows a withheld state without presenting candidate names as labels", () => {
    render(
      <SpeakerNameAttributionBadge
        attribution={attribution({
          resolution: "withheld",
          displayName: undefined,
          confidence: 0.82,
          candidateNames: [
            {
              name: "Sarah Kim",
              normalizedName: "sarah kim",
              confidence: 0.82,
              sources: ["calendar_attendee"],
              provenance: [{ source: "calendar_attendee", confidence: 0.82 }],
            },
            {
              name: "Sarah Patel",
              normalizedName: "sarah patel",
              confidence: 0.82,
              sources: ["calendar_attendee"],
              provenance: [{ source: "calendar_attendee", confidence: 0.82 }],
            },
          ],
          provenance: [{ source: "calendar_attendee", confidence: 0.82 }],
          reasonCodes: ["same_first_name_ambiguity"],
          requiresReview: true,
        })}
      />,
    );
    const badge = screen.getByTestId("speaker-name-attribution");
    expect(badge.textContent).toContain("Withheld");
    expect(badge.textContent).not.toContain("Sarah Kim");
    expect(badge.textContent).not.toContain("Sarah Patel");
    expect(badge.getAttribute("title")).toContain("candidates: Sarah Kim");
  });
});
