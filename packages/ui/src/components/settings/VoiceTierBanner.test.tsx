// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  VoiceTierBanner,
  VOICE_DEVICE_TIERS,
} from "./VoiceTierBanner";

afterEach(() => {
  cleanup();
});

describe("VoiceTierBanner", () => {
  for (const tier of VOICE_DEVICE_TIERS) {
    it(`renders the correct copy for tier=${tier}`, () => {
      render(<VoiceTierBanner tier={tier} summary="16 GB · 8c · Apple" />);
      const root = screen.getByTestId("voice-tier-banner");
      expect(root.getAttribute("data-tier")).toBe(tier);
      expect(screen.getByTestId("voice-tier-badge").textContent).toBe(tier);

      const title = screen.getByTestId("voice-tier-title").textContent ?? "";
      const description =
        screen.getByTestId("voice-tier-description").textContent ?? "";
      expect(title.length).toBeGreaterThan(10);
      expect(description.length).toBeGreaterThan(20);

      // POOR tier must mention cloud (R10 §3.2 "We'll route voice through Eliza Cloud").
      if (tier === "POOR") {
        expect(description.toLowerCase()).toContain("cloud");
      }
      // MAX tier must mention "instant" or "together".
      if (tier === "MAX") {
        expect(description.toLowerCase()).toMatch(/instant|together/);
      }
    });
  }

  it("renders the summary line when supplied", () => {
    render(<VoiceTierBanner tier="GOOD" summary="32 GB RAM · 12 cores" />);
    expect(screen.getByTestId("voice-tier-summary").textContent).toContain(
      "32 GB",
    );
  });

  it("omits the summary when not supplied", () => {
    render(<VoiceTierBanner tier="GOOD" />);
    expect(screen.queryByTestId("voice-tier-summary")).toBeNull();
  });
});
