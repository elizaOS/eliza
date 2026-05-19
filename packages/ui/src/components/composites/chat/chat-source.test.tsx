// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  ChatVoiceSpeakerBadge,
  resolveChatVoiceSpeakerLabel,
} from "./chat-source";

afterEach(() => {
  cleanup();
});

describe("resolveChatVoiceSpeakerLabel", () => {
  it("returns null when the speaker has no name or userName", () => {
    expect(resolveChatVoiceSpeakerLabel(null)).toBeNull();
    expect(resolveChatVoiceSpeakerLabel(undefined)).toBeNull();
    expect(resolveChatVoiceSpeakerLabel({})).toBeNull();
    expect(resolveChatVoiceSpeakerLabel({ name: "", userName: "" })).toBeNull();
  });

  it("prefers name over userName", () => {
    expect(resolveChatVoiceSpeakerLabel({ name: "Alex", userName: "ax" })).toBe(
      "Alex",
    );
  });

  it("falls back to userName when name is missing", () => {
    expect(resolveChatVoiceSpeakerLabel({ userName: "ax" })).toBe("ax");
  });
});

describe("ChatVoiceSpeakerBadge", () => {
  it("renders nothing when the speaker is null", () => {
    const { container } = render(<ChatVoiceSpeakerBadge speaker={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the speaker has no usable label", () => {
    const { container } = render(<ChatVoiceSpeakerBadge speaker={{}} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders the speaker name when present", () => {
    render(<ChatVoiceSpeakerBadge speaker={{ name: "Alex" }} />);
    const badge = screen.getByTestId("chat-voice-speaker");
    expect(badge.textContent).toContain("Alex");
  });

  it("shows the OWNER crown affordance when isOwner is true", () => {
    render(<ChatVoiceSpeakerBadge speaker={{ name: "Shaw", isOwner: true }} />);
    expect(screen.getByTestId("chat-voice-speaker-owner-crown")).toBeTruthy();
    expect(
      screen.getByTestId("chat-voice-speaker").getAttribute("data-owner"),
    ).toBe("true");
  });

  it("does not render the crown for non-OWNER speakers", () => {
    render(<ChatVoiceSpeakerBadge speaker={{ name: "Alex" }} />);
    expect(screen.queryByTestId("chat-voice-speaker-owner-crown")).toBeNull();
    expect(
      screen.getByTestId("chat-voice-speaker").getAttribute("data-owner"),
    ).toBeNull();
  });

  it("uses the userName when name is missing", () => {
    render(<ChatVoiceSpeakerBadge speaker={{ userName: "alex_handle" }} />);
    expect(screen.getByTestId("chat-voice-speaker").textContent).toContain(
      "alex_handle",
    );
  });
});
