// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { __setAppValueForTests } from "../state/app-store";
import { AppBackground } from "./AppBackground";

function seed(backgroundConfig: unknown) {
  __setAppValueForTests({
    backgroundConfig,
    setBackgroundConfig: () => {},
  } as never);
}

afterEach(() => {
  cleanup();
  __setAppValueForTests(null);
});

describe("AppBackground", () => {
  it("renders the shader in the configured color by default", () => {
    seed({ mode: "shader", color: "#ef5a1f" });
    const { container } = render(<AppBackground />);
    const shader = container.querySelector<HTMLElement>(
      '[data-testid="app-background-shader"]',
    );
    expect(shader).not.toBeNull();
    expect(shader?.style.backgroundColor).toBe("rgb(239, 90, 31)");
    expect(
      container.querySelector('[data-testid="app-background-image"]'),
    ).toBeNull();
  });

  it("renders a cover image when configured for image mode", () => {
    seed({ mode: "image", color: "#000000", imageUrl: "/api/media/x.png" });
    const { container } = render(<AppBackground />);
    const image = container.querySelector<HTMLElement>(
      '[data-testid="app-background-image"]',
    );
    expect(image).not.toBeNull();
    expect(image?.style.backgroundImage).toContain("/api/media/x.png");
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).toBeNull();
  });

  it("falls back to the shader when the config slice is missing", () => {
    __setAppValueForTests({} as never);
    const { container } = render(<AppBackground />);
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).not.toBeNull();
  });
});
