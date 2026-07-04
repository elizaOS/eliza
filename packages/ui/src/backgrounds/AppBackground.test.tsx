// @vitest-environment jsdom

/**
 * Verifies AppBackground reads the persisted BackgroundConfig from app state
 * and renders the matching surface: a shader host in the configured color for
 * `mode: shader`, an image host for `mode: image`. jsdom render over a seeded
 * store double.
 */
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

  it("renders the programmable shader (or its color-field fallback) for glsl mode", () => {
    seed({
      mode: "glsl",
      color: "#059669",
      shader: {
        presetId: "aurora",
        source:
          "precision highp float; void main(){ gl_FragColor = vec4(1.0); }",
        uniforms: { u_speed: 1, u_scale: 1, u_intensity: 1, u_seed: 0 },
      },
    });
    const { container } = render(<AppBackground />);
    // In jsdom there's no WebGL, so the glsl layer's safety path swaps in the
    // color field — either way a background layer must be present (no blank/crash).
    const glsl = container.querySelector('[data-testid="app-background-glsl"]');
    const shader = container.querySelector(
      '[data-testid="app-background-shader"]',
    );
    expect(glsl || shader).not.toBeNull();
  });

  it("falls back to the color field when a glsl config has no shader payload", () => {
    seed({ mode: "glsl", color: "#059669" });
    const { container } = render(<AppBackground />);
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).not.toBeNull();
  });

  it("falls back to the shader when the config slice is missing", () => {
    __setAppValueForTests({} as never);
    const { container } = render(<AppBackground />);
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).not.toBeNull();
  });

  it("keeps the apply channel mounted while hiding the visual layer", () => {
    seed({ mode: "shader", color: "#ef5a1f" });
    const { container } = render(<AppBackground visible={false} />);
    expect(
      container.querySelector('[data-testid="app-background-shader"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="app-background-image"]'),
    ).toBeNull();
  });
});
