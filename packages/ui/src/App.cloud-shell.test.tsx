// @vitest-environment jsdom

/**
 * Pre-agent / home-screen brand wiring test.
 *
 * Asserts that `App.tsx` wraps the StartupScreen (pre-agent gate) in
 * `<CloudVideoBackground>` so the home screen renders over CLOUDS per brand,
 * and that the cloud component itself can produce either the expected `<video>`
 * element with cloud sources or a static poster for startup. Rendering the full <App> would require mocking the
 * entire AppContext + boot config + capacitor surfaces, which is brittle —
 * this hits the two load-bearing facts directly.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render, waitFor } from "@testing-library/react";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// React 19's scheduler can post a `setImmediate` callback that runs AFTER
// the test file completes but while Vitest is tearing down the per-file
// jsdom environment, throwing `ReferenceError: window is not defined`
// from react-dom-client.development.js. Drain the macrotask queue before
// the environment is unwound so any pending scheduler work runs while
// `window` still exists.
afterAll(async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
});

beforeEach(() => {
  Object.defineProperty(HTMLMediaElement.prototype, "pause", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
  Object.defineProperty(HTMLMediaElement.prototype, "play", {
    configurable: true,
    writable: true,
    value: vi.fn().mockResolvedValue(undefined),
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
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
  Object.defineProperty(window, "requestAnimationFrame", {
    configurable: true,
    writable: true,
    value: vi.fn((callback: FrameRequestCallback) => {
      queueMicrotask(() => callback(0));
      return 1;
    }),
  });
  Object.defineProperty(window, "cancelAnimationFrame", {
    configurable: true,
    writable: true,
    value: vi.fn(),
  });
});

afterEach(() => cleanup());

import { CLOUD_BACKGROUND_ASSETS } from "@elizaos/shared/brand";
import { CloudVideoBackground } from "./backgrounds/CloudVideoBackground";

const APP_TSX = readFileSync(resolve(__dirname, "./App.tsx"), "utf8");
const APP_MAIN_TS = readFileSync(
  resolve(__dirname, "../../app/src/main.tsx"),
  "utf8",
);
const USE_NAVIGATION_STATE_TS = readFileSync(
  resolve(__dirname, "./state/useNavigationState.ts"),
  "utf8",
);
const USE_STARTUP_SHELL_CONTROLLER_TS = readFileSync(
  resolve(__dirname, "./state/use-startup-shell-controller.ts"),
  "utf8",
);
const WINDOW_SHELL_TS = readFileSync(
  resolve(__dirname, "./platform/window-shell.ts"),
  "utf8",
);

describe("App pre-agent cloud wiring", () => {
  it("wraps the pre-agent StartupScreen in a full-screen CloudVideoBackground", () => {
    // Pull the contents of the `if (startupCoordinator.phase !== "ready" …)`
    // pre-agent gate and assert clouds are wired there. We grep for the
    // testid we added so the assertion fails loudly if the wrapper is moved.
    expect(APP_TSX).toContain(
      'import { CloudVideoBackground } from "./backgrounds/CloudVideoBackground"',
    );
    expect(APP_TSX).toContain('data-testid="pre-agent-cloud-shell"');
    expect(APP_TSX).toMatch(
      /<CloudVideoBackground[\s\S]*<StartupScreen[\s\S]*<\/CloudVideoBackground>/,
    );
    // The clouds are a true full-viewport background (fixed inset:0) with a
    // light scrim and theme-aware black text layered above.
    expect(APP_TSX).toMatch(/position: "fixed"/);
    expect(APP_TSX).toMatch(/scrim=\{0\.05\}/);
    expect(APP_TSX).toMatch(/text-txt/);
  });

  it("shows the poster first, then streams the cloud loop video over it", async () => {
    const { container } = render(
      <CloudVideoBackground scrim={0.05}>
        <div data-testid="welcome">welcome</div>
      </CloudVideoBackground>,
    );

    // Poster image is present immediately (jpeg-first).
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      CLOUD_BACKGROUND_ASSETS.poster,
    );

    // The video layer mounts after the deferred post-load tick.
    await waitFor(
      () => {
        expect(container.querySelector("video")).not.toBeNull();
      },
      { timeout: 2000 },
    );
    const video = container.querySelector("video");
    expect(video?.getAttribute("preload")).toBe("auto");
    expect(video?.getAttribute("poster")).toBe(CLOUD_BACKGROUND_ASSETS.poster);

    const srcAttrs = Array.from(
      container.querySelectorAll("video > source"),
    ).map((s) => s.getAttribute("src"));
    expect(srcAttrs).toContain(CLOUD_BACKGROUND_ASSETS.source1080pMp4);

    // children still rendered above the video
    expect(
      container.querySelector('[data-testid="welcome"]')?.textContent,
    ).toBe("welcome");
  });

  it("renders only the poster when not animated", () => {
    const { container } = render(
      <CloudVideoBackground
        animated={false}
        poster={CLOUD_BACKGROUND_ASSETS.poster}
      >
        <div data-testid="welcome">welcome</div>
      </CloudVideoBackground>,
    );

    expect(container.querySelector("video")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toBe(
      CLOUD_BACKGROUND_ASSETS.poster,
    );
    expect(
      container.querySelector('[data-testid="welcome"]')?.textContent,
    ).toBe("welcome");
  });

  it("keeps the assistant pill out of the full app shell", () => {
    expect(APP_TSX).toContain("home: <HomeView />");
    expect(APP_TSX).toContain('shellMode === "chat-overlay"');
    expect(APP_TSX).toContain("<ShellFoundationMount />");
    expect(APP_TSX).toContain("pointer-events-none fixed inset-0");
    expect(APP_TSX).not.toContain(
      "{isCoordinatorReady && <ShellFoundationMount />}",
    );
    expect(APP_TSX.indexOf('shellMode === "chat-overlay"')).toBeLessThan(
      APP_TSX.indexOf(
        'startupCoordinator.phase !== "ready" || !firstRunComplete',
      ),
    );
  });

  it("classifies chat-overlay as a standalone shell, not the main app", () => {
    expect(WINDOW_SHELL_TS).toContain('shellMode === "chat-overlay"');
    expect(WINDOW_SHELL_TS).toContain('{ mode: "chat-overlay" }');
    expect(WINDOW_SHELL_TS).toContain("isChatOverlayWindowShell");
    expect(WINDOW_SHELL_TS).toContain("isStandaloneWindowShell");
    expect(WINDOW_SHELL_TS).toContain('route.mode === "chat-overlay"');
    expect(APP_MAIN_TS).toContain("isStandaloneWindowShell(windowShellRoute)");
    expect(APP_MAIN_TS).toContain("isChatOverlayWindowShell(windowShellRoute)");
  });

  it("preserves chat-overlay shell mode during shell-window navigation", () => {
    expect(USE_NAVIGATION_STATE_TS).toContain("pathWithCurrentShellMode");
    expect(USE_NAVIGATION_STATE_TS).toContain("isDetachedShell");
    expect(USE_NAVIGATION_STATE_TS).toContain("eliza-chat-overlay-shell");
    expect(USE_NAVIGATION_STATE_TS).toContain(
      "if (!isDetachedShell) return path",
    );
    expect(USE_NAVIGATION_STATE_TS).toContain('params.get("shellMode")');
    expect(USE_NAVIGATION_STATE_TS).toContain('params.get("shell-mode")');
    expect(USE_NAVIGATION_STATE_TS).toContain(
      'window.history.pushState(null, "", pathWithCurrentShellMode(path))',
    );
  });

  it("lets existing shell windows advance after onboarding finishes elsewhere", () => {
    expect(USE_STARTUP_SHELL_CONTROLLER_TS).toContain(".getFirstRunStatus()");
    expect(USE_STARTUP_SHELL_CONTROLLER_TS).toContain(
      "status.cloudProvisioned",
    );
    expect(USE_STARTUP_SHELL_CONTROLLER_TS).toContain(
      'setState("firstRunComplete", true)',
    );
    expect(USE_STARTUP_SHELL_CONTROLLER_TS).toContain(
      'coordinatorDispatchRef.current({ type: "FIRST_RUN_COMPLETE" })',
    );
  });
});
