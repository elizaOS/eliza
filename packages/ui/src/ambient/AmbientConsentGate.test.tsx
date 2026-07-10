/**
 * Tests the ambient consent gate: it affirms per processing path (no
 * contradictory cloud/on-device disclosure), carries the two-party reminder,
 * and grants on the explicit action only.
 */

// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AmbientConsentGate } from "./AmbientConsentGate";

afterEach(cleanup);

describe("AmbientConsentGate", () => {
  it("states cloud processing for the cloud path (no on-device claim)", () => {
    render(
      <AmbientConsentGate processingLocation="cloud" onGrant={vi.fn()} />,
    );
    const gate = screen.getByTestId("ambient-consent-gate");
    const text = gate.textContent?.toLowerCase() ?? "";
    expect(text).toContain("cloud");
    expect(text).not.toContain("on this device");
    expect(screen.getByTestId("ambient-two-party-reminder")).toBeTruthy();
  });

  it("states on-device processing for the batch path (no cloud claim in the affirmation)", () => {
    render(
      <AmbientConsentGate processingLocation="on-device" onGrant={vi.fn()} />,
    );
    const affirmation = screen
      .getByTestId("ambient-consent-gate")
      .querySelector("p")?.textContent
      ?.toLowerCase();
    expect(affirmation).toContain("on this device");
    expect(affirmation).not.toContain("cloud");
  });

  it("grants only on the explicit action", () => {
    const onGrant = vi.fn();
    render(
      <AmbientConsentGate processingLocation="cloud" onGrant={onGrant} />,
    );
    expect(onGrant).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("ambient-consent-grant"));
    expect(onGrant).toHaveBeenCalledTimes(1);
  });
});
