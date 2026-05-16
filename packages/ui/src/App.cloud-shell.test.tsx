// @vitest-environment jsdom

/**
 * Pre-agent / home-screen brand wiring test.
 *
 * Asserts that `App.tsx` wraps the StartupShell (pre-agent gate) in
 * `<CloudVideoBackground>` so the home screen renders over CLOUDS per brand,
 * and that the cloud component itself produces the expected `<video>` element
 * with cloud sources. Rendering the full <App> would require mocking the
 * entire AppContext + boot config + capacitor surfaces, which is brittle —
 * this hits the two load-bearing facts directly.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { render } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
  if (typeof window.matchMedia !== "function") {
    Object.defineProperty(window, "matchMedia", {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  }
});

import { CloudVideoBackground } from "./backgrounds/CloudVideoBackground";

const APP_TSX = readFileSync(
  resolve(__dirname, "./App.tsx"),
  "utf8",
);

describe("App pre-agent cloud wiring", () => {
  it("wraps the pre-agent StartupShell in CloudVideoBackground", () => {
    // Pull the contents of the `if (startupCoordinator.phase !== "ready" …)`
    // pre-agent gate and assert clouds are wired there. We grep for the
    // testid we added so the assertion fails loudly if the wrapper is moved.
    expect(APP_TSX).toContain(
      'import { CloudVideoBackground } from "./backgrounds/CloudVideoBackground"',
    );
    expect(APP_TSX).toContain('data-testid="pre-agent-cloud-shell"');
    expect(APP_TSX).toMatch(/<CloudVideoBackground[\s\S]*<StartupShell[\s\S]*<\/CloudVideoBackground>/);
    // Brand rules: 8x speed, /clouds basePath, light scrim, black text.
    expect(APP_TSX).toMatch(/speed="8x"/);
    expect(APP_TSX).toMatch(/basePath="\/clouds"/);
    expect(APP_TSX).toMatch(/scrim=\{0\.05\}/);
    expect(APP_TSX).toMatch(/text-black/);
  });

  it("CloudVideoBackground renders a <video> with cloud sources", () => {
    const { container } = render(
      <CloudVideoBackground
        speed="8x"
        basePath="/clouds"
        poster="/clouds/poster.jpg"
        scrim={0.05}
      >
        <div data-testid="welcome">welcome</div>
      </CloudVideoBackground>,
    );

    const video = container.querySelector("video");
    expect(video).not.toBeNull();
    expect(video?.getAttribute("poster")).toBe("/clouds/poster.jpg");

    const sources = container.querySelectorAll("video > source");
    expect(sources.length).toBeGreaterThan(0);
    const srcAttrs = Array.from(sources).map((s) => s.getAttribute("src"));
    expect(srcAttrs.some((s) => s?.includes("/clouds/clouds_8x_"))).toBe(true);

    // children still rendered above the video
    expect(container.querySelector('[data-testid="welcome"]')?.textContent).toBe(
      "welcome",
    );
  });
});
