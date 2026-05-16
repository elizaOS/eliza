// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { VoicePill } from "./VoicePill";

afterEach(() => {
  cleanup();
});

describe("VoicePill", () => {
  it("renders the pill collapsed by default", () => {
    const { container, getByRole } = render(<VoicePill />);
    const hit = getByRole("button", { name: "Eliza" });
    expect(hit.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".eliza-voice-pill")).not.toBeNull();
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
});
