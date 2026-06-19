/**
 * Standalone chat-overlay window-shell wiring test.
 *
 * Source-level invariants for the detached chat-overlay shell and how it is
 * classified and navigated. (The former pre-agent crystal-ball home backdrop
 * and the home screen have been removed; the app now lands on /onboarding and
 * then /chat.)
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  isChatOverlayWindowShell,
  isDetachedWindowShell,
  isStandaloneWindowShell,
  parseWindowShellRoute,
  resolveDetachedShellTarget,
} from "./platform/window-shell";

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
const OVERLAY_TSX = readFileSync(
  resolve(__dirname, "./components/shell/ContinuousChatOverlay.tsx"),
  "utf8",
);
const CHATVIEW_TSX = readFileSync(
  resolve(__dirname, "./components/pages/ChatView.tsx"),
  "utf8",
);

describe("App standalone chat-overlay wiring", () => {
  it("mounts the continuous chat overlay outside the full chat tab", () => {
    expect(APP_TSX).toContain('shellMode === "chat-overlay"');
    expect(APP_TSX).toContain("<ShellFoundationMount />");
    expect(APP_TSX).toContain("pointer-events-none fixed inset-0");
    // The floating glass chat remains available in the main shell, including
    // the ambient /chat route.
    expect(APP_TSX).toContain("Continuous chat overlay");
    expect(APP_TSX).toContain("<ContinuousChatOverlayMount />");
  });

  it("renders a header-less app shell", () => {
    // The app shell mounts no Header anywhere — navigation is conversational
    // (the always-present chat overlay). The Header component has been removed
    // from the library entirely (pill-only nav), so nothing can mount it.
    expect(APP_TSX).toContain("function ChatRouteShellContent");
    expect(APP_TSX).toContain("ChatAmbientBackground");
    expect(APP_TSX).not.toContain("<Header");
    expect(APP_TSX).not.toContain('from "./components/shell/Header"');
    expect(APP_TSX).not.toContain("function FullChatWorkspaceShellContent");
  });

  it("renders the ambient chat route as a header-less, wordless backdrop home", () => {
    expect(APP_TSX).toContain("function ChatRouteShellContent");
    expect(APP_TSX).toContain('<div key="chat-shell"');
    // The home is a wordless ambient orange backdrop (no greeting text) under
    // the always-present chat overlay; the shell mounts no Header.
    expect(APP_TSX).toContain("<ChatAmbientBackground />");
    expect(APP_TSX).not.toContain("minimalHomeGreeting");
    expect(APP_TSX).not.toContain("<Header />");
  });

  it("keeps the ambient overlay composer as the chat route composer", () => {
    // ChatView still supports hidden-composer embedding, but /chat now uses the
    // persistent ambient overlay as its composer.
    expect(CHATVIEW_TSX).toContain("hideComposer");
    expect(APP_TSX).toContain("<ContinuousChatOverlayMount />");
    expect(APP_TSX).toContain("floats over EVERY view, including the /chat");
    // The composer swaps mic→send once there's a draft (one trailing control).
    expect(OVERLAY_TSX).toContain("hasDraft");
    expect(OVERLAY_TSX).toContain("(hasDraft || hasImages) && !recording");
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

// Behavioral coverage of the window-shell classification the wiring above only
// asserts textually — these are pure functions, so we exercise the real logic.
describe("window-shell route classification (behavioral)", () => {
  it("parses the chat-overlay shellMode under both param spellings", () => {
    expect(parseWindowShellRoute("?shellMode=chat-overlay")).toEqual({
      mode: "chat-overlay",
    });
    expect(parseWindowShellRoute("?shell-mode=chat-overlay")).toEqual({
      mode: "chat-overlay",
    });
  });

  it("parses settings / surface / pill shells and falls back to main", () => {
    expect(parseWindowShellRoute("")).toEqual({ mode: "main" });
    expect(parseWindowShellRoute("?shell=settings&tab=cloud")).toEqual({
      mode: "settings",
      tab: "cloud",
    });
    expect(parseWindowShellRoute("?shell=surface&tab=browser")).toEqual({
      mode: "surface",
      tab: "browser",
    });
    // ?shell=pill is gone (the separate voice pill was removed) → main.
    expect(parseWindowShellRoute("?shell=pill")).toEqual({ mode: "main" });
    // Unknown surface tab is not a valid detached target → main.
    expect(parseWindowShellRoute("?shell=surface&tab=bogus")).toEqual({
      mode: "main",
    });
  });

  it("classifies chat-overlay as standalone but NOT detached", () => {
    const route = parseWindowShellRoute("?shellMode=chat-overlay");
    expect(isChatOverlayWindowShell(route)).toBe(true);
    expect(isStandaloneWindowShell(route)).toBe(true);
    // The overlay floats inside the app — it has no detached window target.
    expect(isDetachedWindowShell(route)).toBe(false);
  });

  it("treats the main shell as neither standalone nor chat-overlay", () => {
    const route = parseWindowShellRoute("");
    expect(isStandaloneWindowShell(route)).toBe(false);
    expect(isChatOverlayWindowShell(route)).toBe(false);
    expect(isDetachedWindowShell(route)).toBe(false);
  });

  it("maps detached surface routes to a target and refuses non-detached ones", () => {
    expect(
      resolveDetachedShellTarget(
        parseWindowShellRoute("?shell=surface&tab=release"),
      ),
    ).toEqual({ tab: "settings", settingsSection: "updates" });
    expect(() =>
      resolveDetachedShellTarget(
        parseWindowShellRoute("?shellMode=chat-overlay"),
      ),
    ).toThrow();
    expect(() =>
      resolveDetachedShellTarget(parseWindowShellRoute("")),
    ).toThrow();
  });
});
