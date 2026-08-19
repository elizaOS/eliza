/** Certifies the real resting-pill component with deterministic jsdom geometry. */
// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  certifyWidget,
  type GeometryProvider,
} from "../../testing/widget-cert";
import { RestingPillButton } from "./RestingPillButton";

afterEach(cleanup);

describe("RestingPillButton", () => {
  it("certifies one fully painted 64x44 tap target", () => {
    const { container } = render(<RestingPillButton aria-label="Open Eliza" />);
    const button = screen.getByRole("button", { name: "Open Eliza" });
    const geometry: GeometryProvider = {
      box: (element) =>
        element === button
          ? { top: 0, left: 0, width: 64, height: 44 }
          : { top: 0, left: 0, width: 0, height: 0 },
      computed: () => ({ overflowX: "visible", overflowY: "visible" }),
    };

    expect(button.className).toContain("h-11");
    expect(button.className).toContain("w-16");
    expect(button.className).toContain("bg-[#181a20]/95");
    expect(
      certifyWidget("resting-pill-button", container, geometry, {
        dimensions: ["tap-target"],
      }),
    ).toMatchObject({ passed: true, violations: [] });
  });
});
