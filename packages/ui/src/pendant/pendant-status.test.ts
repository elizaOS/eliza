/**
 * Shared pendant status labels stay identical across transcript and settings UI.
 */

import { describe, expect, it } from "vitest";
import {
  isPendantLiveStatus,
  pendantConnectStepLabel,
  pendantStatusLabel,
} from "./pendant-status";

describe("pendant status vocabulary", () => {
  it("keeps reconnecting labelled but outside live-state checks", () => {
    expect(pendantStatusLabel("reconnecting")).toBe("Reconnecting...");
    expect(isPendantLiveStatus("reconnecting")).toBe(false);
  });

  it("shares human connect step labels", () => {
    expect(pendantConnectStepLabel("start-notifications")).toBe(
      "subscribing to audio",
    );
    expect(pendantConnectStepLabel("idle")).toBeNull();
  });
});
