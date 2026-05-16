// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VoicePill } from "./VoicePill";

afterEach(() => {
  cleanup();
});

describe("VoicePill", () => {
  it("renders the pill collapsed by default", () => {
    const { container, getByRole } = render(<VoicePill />);
    const hit = getByRole("button", { name: "Eliza" });
    expect(hit.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".elizaos-voice-pill-pill")).not.toBeNull();
  });

  it("toggles aria-expanded when the hit area is clicked", () => {
    const { getByRole } = render(<VoicePill />);
    const hit = getByRole("button", { name: "Eliza" });
    expect(hit.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      fireEvent.click(hit);
    });
    expect(hit.getAttribute("aria-expanded")).toBe("true");
    act(() => {
      fireEvent.click(hit);
    });
    expect(hit.getAttribute("aria-expanded")).toBe("false");
  });

  it("uses a custom aria-label when provided", () => {
    const { getByRole } = render(<VoicePill ariaLabel="Milady" />);
    expect(getByRole("button", { name: "Milady" })).not.toBeNull();
  });

  it("fires onSubmit with trimmed text and clears the input", () => {
    const onSubmit = vi.fn();
    const { getByLabelText, getByRole } = render(
      <VoicePill open onSubmit={onSubmit} />,
    );
    const input = getByLabelText("Message Eliza") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "  hello  " } });
    });
    act(() => {
      fireEvent.click(getByRole("button", { name: "Send" }));
    });
    expect(onSubmit).toHaveBeenCalledWith("hello");
    expect(input.value).toBe("");
  });

  it("fires onSubmit on Enter", () => {
    const onSubmit = vi.fn();
    const { getByLabelText } = render(<VoicePill open onSubmit={onSubmit} />);
    const input = getByLabelText("Message Eliza") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "hi" } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("ignores empty/whitespace-only submits", () => {
    const onSubmit = vi.fn();
    const { getByRole } = render(<VoicePill open onSubmit={onSubmit} />);
    act(() => {
      fireEvent.click(getByRole("button", { name: "Send" }));
    });
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("toggles recording when the mic is clicked (uncontrolled)", () => {
    const onRecordingChange = vi.fn();
    const { container, getByRole } = render(
      <VoicePill open onRecordingChange={onRecordingChange} />,
    );
    const mic = getByRole("button", { name: "Audio" });
    expect(mic.getAttribute("aria-pressed")).toBe("false");
    act(() => {
      fireEvent.click(mic);
    });
    expect(mic.getAttribute("aria-pressed")).toBe("true");
    expect(onRecordingChange).toHaveBeenCalledWith(true);
    expect(
      container.querySelector(".elizaos-voice-pill-pill.is-recording"),
    ).not.toBeNull();
  });

  it("fires onAdd when the + button is clicked", () => {
    const onAdd = vi.fn();
    const { getByRole } = render(<VoicePill open onAdd={onAdd} />);
    act(() => {
      fireEvent.click(getByRole("button", { name: "Add" }));
    });
    expect(onAdd).toHaveBeenCalledTimes(1);
  });

  it("renders messages with role classes", () => {
    const { container } = render(
      <VoicePill
        open
        messages={[
          { id: "1", role: "agent", text: "Hi" },
          { id: "2", role: "user", text: "Hello" },
        ]}
      />,
    );
    expect(
      container.querySelectorAll(".elizaos-voice-pill-msg.is-agent").length,
    ).toBe(1);
    expect(
      container.querySelectorAll(".elizaos-voice-pill-msg.is-user").length,
    ).toBe(1);
  });

  it("honors controlled open prop and calls onOpenChange", () => {
    const onOpenChange = vi.fn();
    const { getByRole } = render(
      <VoicePill open={false} onOpenChange={onOpenChange} />,
    );
    const hit = getByRole("button", { name: "Eliza" });
    expect(hit.getAttribute("aria-expanded")).toBe("false");
    act(() => {
      fireEvent.click(hit);
    });
    expect(onOpenChange).toHaveBeenCalledWith(true);
    // Still false because the prop is controlled and parent did not update it.
    expect(hit.getAttribute("aria-expanded")).toBe("false");
  });
});
