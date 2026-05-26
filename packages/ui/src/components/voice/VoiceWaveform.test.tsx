// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { VoiceWaveform } from "./VoiceWaveform";

afterEach(() => cleanup());

describe("VoiceWaveform", () => {
  it("renders a canvas with the active mode and accessible label", () => {
    render(<VoiceWaveform mode="idle" ariaLabel="Voice activity" />);
    const canvas = screen.getByRole("img", { name: /voice activity/i });
    expect(canvas.tagName).toBe("CANVAS");
    expect(canvas.getAttribute("data-mode")).toBe("idle");
  });

  it("reflects the listening mode", () => {
    render(<VoiceWaveform mode="listening" />);
    expect(screen.getByTestId("voice-waveform").getAttribute("data-mode")).toBe(
      "listening",
    );
  });

  it("does not open its own microphone by default in listening mode", () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia },
    });

    render(<VoiceWaveform mode="listening" />);

    expect(getUserMedia).not.toHaveBeenCalled();
  });
});
