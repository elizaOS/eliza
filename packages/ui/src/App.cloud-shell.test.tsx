// @vitest-environment jsdom

/**
 * Pre-agent / home-screen brand wiring test.
 *
 * Asserts that `App.tsx` wraps the StartupScreen (pre-agent gate) in
 * `<HomescreenBackdrop>` so onboarding renders over the brand's living
 * crystal-ball-over-orange scene (clouds removed), and that the backdrop itself
 * paints brand orange and layers its children above the canvas. Rendering the
 * full <App> would require mocking the entire AppContext + boot config +
 * capacitor surfaces, which is brittle — this hits the load-bearing facts
 * directly.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { cleanup, render } from "@testing-library/react";
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

import { HomescreenBackdrop } from "./backgrounds/HomescreenBackdrop";

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
  it("wraps the pre-agent StartupScreen in a full-screen HomescreenBackdrop", () => {
    // Pull the contents of the `if (startupCoordinator.phase !== "ready" …)`
    // pre-agent gate and assert the crystal-ball backdrop is wired there. We
    // grep for the testid we kept so the assertion fails loudly if the wrapper
    // is moved.
    expect(APP_TSX).toContain(
      'import { HomescreenBackdrop } from "./backgrounds/HomescreenBackdrop"',
    );
    expect(APP_TSX).toContain('data-testid="pre-agent-cloud-shell"');
    expect(APP_TSX).toMatch(
      /<HomescreenBackdrop[\s\S]*<StartupScreen[\s\S]*<\/HomescreenBackdrop>/,
    );
    // The backdrop is a true full-viewport background (fixed inset:0) with
    // theme-aware text layered above the crystal-ball canvas.
    expect(APP_TSX).toMatch(/position: "fixed"/);
    expect(APP_TSX).toMatch(/text-txt/);
  });

  it("paints brand orange and mounts the crystal-ball canvas behind its children", () => {
    const { container } = render(
      <HomescreenBackdrop>
        <div data-testid="welcome">welcome</div>
      </HomescreenBackdrop>,
    );

    // The crystal-ball canvas container mounts (empty in jsdom — no WebGL).
    expect(
      container.querySelector('[data-testid="homescreen-canvas"]'),
    ).not.toBeNull();

    // The wrapper paints brand orange so onboarding is on-brand even before
    // WebGL initializes (reduced-motion, jsdom, SSR).
    const root = container.firstElementChild as HTMLElement;
    expect(root.style.background).toContain("--brand-orange");

    // children still rendered above the canvas
    expect(
      container.querySelector('[data-testid="welcome"]')?.textContent,
    ).toBe("welcome");
  });

  it("layers the children wrapper above the canvas in Z order", () => {
    const { container } = render(
      <HomescreenBackdrop>
        <div data-testid="welcome">welcome</div>
      </HomescreenBackdrop>,
    );

    const welcome = container.querySelector('[data-testid="welcome"]');
    const wrapper = welcome?.parentElement as HTMLElement;
    expect(wrapper.style.zIndex).toBe("1");
    expect(wrapper.style.position).toBe("relative");
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

  it("renders the home shell while a completed agent is still starting", () => {
    expect(APP_TSX).toContain("function canRenderStartupHome");
    expect(APP_TSX).toContain('phase === "starting-runtime"');
    expect(APP_TSX).toContain('phase === "hydrating"');
    expect(APP_TSX).toContain("!renderStartupHome");
    expect(APP_TSX).toContain('data-testid="pre-agent-home-shell"');
    expect(APP_TSX).toContain("<HomeShellContent />");
  });
});
