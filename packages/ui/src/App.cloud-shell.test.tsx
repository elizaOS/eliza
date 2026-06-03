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
const HEADER_TSX = readFileSync(
  resolve(__dirname, "./components/shell/Header.tsx"),
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
    // The floating glass chat remains available in the main shell, but the full
    // chat tab keeps its richer in-view composer unless minimal shell is enabled.
    expect(APP_TSX).toContain("Continuous chat overlay");
    expect(APP_TSX).toContain('tab !== "chat" || MINIMAL_SHELL');
  });

  it("gates the minimal conversational-OS shell behind MINIMAL_SHELL", () => {
    // The flag drives both the minimal home and the header-nav suppression.
    expect(APP_TSX).toContain('from "./components/shell/shell-chrome"');
    expect(APP_TSX).toContain("if (MINIMAL_SHELL)");
    expect(HEADER_TSX).toContain('from "./shell-chrome"');
    expect(HEADER_TSX).toContain("MINIMAL_SHELL ? null");
    // Full chat workspace lives in its own component so its hooks are never
    // called conditionally behind the MINIMAL_SHELL early-return.
    expect(APP_TSX).toContain("function FullChatWorkspaceShellContent");
  });

  it("restores the full 3-panel chat workspace + header nav", () => {
    expect(APP_TSX).toContain("ConversationsSidebar");
    expect(APP_TSX).toContain("TasksEventsPanel");
    expect(APP_TSX).toContain("DeferredSetupChecklist");
    // Header nav restored from the still-present navigation model.
    expect(HEADER_TSX).toContain("getTabGroups");
    expect(HEADER_TSX).toContain("primaryDesktopGroups");
  });

  it("keeps the real chat composer in full shell mode", () => {
    // ChatView can hide its in-view composer for minimal shell experiments, but
    // the full chat workspace keeps the richer composer capabilities available.
    expect(CHATVIEW_TSX).toContain("hideComposer");
    expect(APP_TSX).toContain('<ChatView key="chat-view" />');
    expect(APP_TSX).toContain('tab !== "chat" || MINIMAL_SHELL');
    // The composer swaps mic→send once there's a draft (one trailing control).
    expect(OVERLAY_TSX).toContain("hasDraft");
    expect(OVERLAY_TSX).toContain("hasDraft && !recording");
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
    expect(parseWindowShellRoute("?shell=pill")).toEqual({ mode: "pill" });
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
