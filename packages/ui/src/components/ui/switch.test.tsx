/**
 * Renders the shared Switch and pins off-state thumb contrast classes.
 * jsdom, no visual capture.
 */
// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Switch } from "./switch";

afterEach(() => {
  cleanup();
});

describe("Switch", () => {
  it("uses a text-token thumb when unchecked so it does not match the track", () => {
    const { getByRole } = render(
      <Switch checked={false} aria-label="Example setting" />,
    );
    const track = getByRole("switch");
    const thumb = track.querySelector("[aria-hidden='true']");
    expect(track.getAttribute("data-state")).toBe("unchecked");
    expect(track.className).toContain("data-[state=unchecked]:bg-input");
    expect(thumb?.className).toContain("data-[state=unchecked]:bg-txt");
    expect(thumb?.className).not.toMatch(/data-\[state=unchecked\]:bg-card\b/);
  });

  it("keeps a card-token thumb on the accent track when checked", () => {
    const { getByRole } = render(
      <Switch checked aria-label="Example setting" />,
    );
    const track = getByRole("switch");
    const thumb = track.querySelector("[aria-hidden='true']");
    expect(track.getAttribute("data-state")).toBe("checked");
    expect(track.className).toContain("data-[state=checked]:bg-accent");
    expect(thumb?.className).toContain("data-[state=checked]:bg-card");
  });
});
