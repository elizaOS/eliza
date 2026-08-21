/**
 * Standalone chat-overlay window-shell wiring test.
 *
 * Source-level invariants for the detached chat-overlay shell and how it is
 * classified and navigated: the app lands on /onboarding and then /chat, with
 * no pre-agent home backdrop or home screen. Scans App source, no runtime.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";
import {
  FOCUSED_APP_SHELL_MODES,
  resolveAppShellMode,
} from "./platform/app-shell-mode";
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
  resolve(__dirname, "./components/shell/ChatOverlay.tsx"),
  "utf8",
);
const CHATVIEW_TSX = readFileSync(
  resolve(__dirname, "./components/pages/ChatView.tsx"),
  "utf8",
);

describe("App standalone chat-overlay wiring", () => {
  it("mounts the chat overlay outside the full chat tab", () => {
    expect(APP_TSX).toContain('shellMode === "chat-overlay"');
    expect(APP_TSX).toContain("function ChatOverlayMount(");
    expect(APP_TSX).toContain("pointer-events-none fixed bottom-0 left-1/2");
    // The floating glass chat remains available in the main shell, including
    // the ambient /chat route.
    expect(APP_TSX).toContain("Chat overlay");
    expect(APP_TSX).toContain("<ChatOverlayMount");
    expect(APP_TSX).toContain(
      "releaseFirstRunToHalf={firstRunChatRelease.releasePending}",
    );
    expect(APP_TSX).toContain(
      "onFirstRunChatMounted={firstRunChatRelease.recordMountedOverlay}",
    );
    expect(APP_TSX).toContain(
      "onFirstRunReleaseHandled={firstRunChatRelease.acknowledgeRelease}",
    );
  });

  it("opens the packaged desktop pill into the shared web chat panel", () => {
    const overlayShell = APP_TSX.slice(
      APP_TSX.indexOf("function ChatOverlayShell({"),
      APP_TSX.indexOf("function TrayPopoverShell()"),
    );

    expect(overlayShell).toContain("<GlassStyles />");
    // The detached macOS surface mounts the same ChatOverlayMount used by the
    // full app. It must not route through ShellFoundationMount, whose legacy
    // HomePill/AssistantOverlay path is a distinct implementation.
    expect(overlayShell).toContain("<ChatOverlayMount");
    expect(overlayShell).toContain('initialMode="pill"');
    expect(overlayShell).toContain("initiallyOpen");
    expect(overlayShell).toContain("desktopOverlayHost");
    expect(overlayShell).toContain("requestedOpen={controller?.isOpen}");
    expect(overlayShell).toContain(
      "onWindowSizeClassChange={handleWindowSizeClassChange}",
    );
    expect(overlayShell).toContain(
      "onWindowMaterialSizeChange={reportWindowMaterialSize}",
    );
    expect(overlayShell).not.toContain("<ShellFoundationMount");
    expect(overlayShell).not.toContain("useChatOverlayWindowBounds");
    expect(overlayShell).not.toContain("<AppBackground");
    expect(APP_TSX).toContain("function ChatOverlayMount(");
    expect(APP_TSX).toContain("<ChatOverlay");
  });

  it("seeds in-chat onboarding in the chat-overlay branch (the default desktop bottom-bar surface)", () => {
    // shouldStartBottomBar defaults ON, so createMainWindow boots the MAIN
    // window with ?shellMode=chat-overlay — that branch must mount the
    // headless first-run conductor, or a fresh desktop install boots into the
    // bottom bar with no runtime configured and onboarding never shown
    // (regression guard for the #10720 closure gap: the conductor's only other
    // mount is the full-shell return the bottom bar never reaches).
    const branch = APP_TSX.slice(
      APP_TSX.indexOf('if (shellMode === "chat-overlay") {'),
      APP_TSX.indexOf('if (shellMode === "tray-popover") {'),
    );
    expect(branch).toContain("<ChatOverlayShell");
    expect(branch).toContain("<FirstRunConductorMount");
    expect(branch).toContain(
      "releaseFirstRunToFull={firstRunChatRelease.releasePending}",
    );
    expect(branch).toContain("onFirstRunTranscriptMounted={");
    expect(branch).toContain("<ShellOverlays actionNotice={actionNotice} />");
  });

  it("renders a header-less app shell", () => {
    // The app shell mounts no Header anywhere — navigation is conversational
    // (the always-present chat overlay). The Header component has been removed
    // from the library entirely (pill-only nav), so nothing can mount it.
    expect(APP_TSX).toContain("function ChatRouteShellContent");
    // The unified app background channel is mounted once at the shell root
    // (not per route); only routes that opt into the Home/Launcher
    // background render the visual wallpaper layer.
    expect(APP_TSX).toContain(
      "<AppBackground visible={renderSharedAppBackground} />",
    );
    expect(APP_TSX).not.toContain("<Header");
    expect(APP_TSX).not.toContain('from "./components/shell/Header"');
    expect(APP_TSX).not.toContain("function FullChatWorkspaceShellContent");
  });

  it("renders the ambient chat route as a header-less, wordless backdrop home", () => {
    expect(APP_TSX).toContain("function ChatRouteShellContent");
    expect(APP_TSX).toContain('<div key="chat-shell"');
    // The home is a wordless backdrop (no greeting text) under the always-present
    // chat overlay; its shell is transparent so the unified app background shows
    // through, and it mounts no Header.
    expect(APP_TSX).toContain("APP_SHELL_CLASS_TRANSPARENT");
    expect(APP_TSX).not.toContain("minimalHomeGreeting");
    expect(APP_TSX).not.toContain("<Header />");
  });

  it("keeps the ambient overlay composer as the chat route composer", () => {
    // ChatView still supports hidden-composer embedding, but /chat now uses the
    // persistent ambient overlay as its composer.
    expect(CHATVIEW_TSX).toContain("hideComposer");
    expect(APP_TSX).toContain("<ChatOverlayMount");
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
    expect(USE_NAVIGATION_STATE_TS).toContain(
      'shellHistory.pushState(null, "", pathWithCurrentShellMode(path))',
    );
    expect(FOCUSED_APP_SHELL_MODES).toEqual([
      "chat-overlay",
      "tray-popover",
      "voice-selftest",
      "voice-workbench",
      "launcher",
      "kiosk",
    ]);
    expect(resolveAppShellMode("?shellMode=voice-workbench", "")).toBe(
      "voice-workbench",
    );
    expect(resolveAppShellMode("?shellMode=full", "")).toBe("full");
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
    // ?shell=pill is gone; old links should resolve to the main window.
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
