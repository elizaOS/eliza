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
  it("mounts the continuous chat overlay outside the full chat tab", () => {
    expect(APP_TSX).toContain('shellMode === "chat-overlay"');
    // The desktop bottom-bar (chat-overlay) window renders the SINGULAR
    // ChatOverlay via ChatOverlayMount — the same element the full shell and
    // web/mobile use. The old HomePill+AssistantOverlay+ChatSurface stack
    // (ShellFoundationMount) is gone: there is one chat implementation.
    expect(APP_TSX).not.toContain("ShellFoundationMount");
    // The floating glass chat remains available in the main shell, including
    // the ambient /chat route.
    expect(APP_TSX).toContain("Continuous chat overlay");
    expect(APP_TSX).toContain("<ChatOverlayMount />");
  });

  it("keeps the tray popover a lightweight 3-item menu: Focus Chat, Views ▸, Quit", () => {
    // The menu-bar tray popover (tray-popover shell) is a separate window that
    // the packaged e2e harness only partially drives, so guard the shape at the
    // source: Focus Chat summons the pill (desktopShowWindow); Views is a
    // COLLAPSED disclosure (tray-views-toggle) whose rows expand on demand — not
    // a flat list cluttering the menu — with the "Open Eliza" tray-show-window
    // row filtered out; Quit tears the app down (desktopQuit). No WidgetHost:
    // the home widgets' loading/boot states read as a "weird loader" in a menu.
    const trayShell = APP_TSX.slice(
      APP_TSX.indexOf("function TrayPopoverShell()"),
      APP_TSX.indexOf("function KioskShell()"),
    );
    expect(trayShell).toContain('data-testid="tray-focus-chat"');
    expect(trayShell).toContain("desktopShowWindow");
    expect(trayShell).toContain('data-testid="tray-views-toggle"');
    expect(trayShell).toContain("setViewsOpen");
    expect(trayShell).toContain('entry.itemId !== "tray-show-window"');
    expect(trayShell).toContain('data-testid="tray-quit"');
    expect(trayShell).toContain("desktopQuit");
    // Lightweight: no home-widget host rendered in the menu (its loading/boot
    // states were the "weird loader"). Assert on the JSX tag, not the word, so
    // the explanatory comment can still name it.
    expect(trayShell).not.toContain("<WidgetHost");
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
    expect(branch).toContain("<ChatOverlayShell />");
    expect(branch).toContain("<FirstRunConductorMount />");
  });

  it("routes every desktop chat surface through the ONE ChatOverlay element", () => {
    // Consolidation guard (#16200): the desktop bottom-bar (ChatOverlayShell)
    // and the Linux kiosk (KioskShell) both render the singular ChatOverlay via
    // ChatOverlayMount — not the retired HomePill/AssistantOverlay/ChatSurface
    // stack. If someone reintroduces a second chat surface for a window, this
    // fails.
    const chatOverlayShell = APP_TSX.slice(
      APP_TSX.indexOf("function ChatOverlayShell()"),
      APP_TSX.indexOf("function TrayPopoverShell()"),
    );
    // The desktop bottom-bar renders ChatOverlayMount, resting as the pill and
    // driving the OS window sizing for click-through (#16200).
    expect(chatOverlayShell).toContain("<ChatOverlayMount");
    expect(chatOverlayShell).toContain("restAtPill");
    expect(chatOverlayShell).toContain("onWindowSizingChange");
    const kioskShell = APP_TSX.slice(
      APP_TSX.indexOf("function KioskShell()"),
      APP_TSX.indexOf("function TabScrollView("),
    );
    expect(kioskShell).toContain("<ChatOverlayMount />");
    // ChatOverlayMount is the ONE shared mount, imported (not redefined) so the
    // detached view windows reuse it via DockedChatOverlay (#16200 Stage 3).
    expect(APP_TSX).toContain('from "./components/shell/ChatOverlayMount"');
    // The single overlay is gated on being the active chat host window, so the
    // chat renders in exactly one window at a time. The gate lives in the shared
    // ChatOverlayMount module now, not inline in App.tsx.
    const MOUNT_TSX = readFileSync(
      resolve(__dirname, "./components/shell/ChatOverlayMount.tsx"),
      "utf8",
    );
    expect(MOUNT_TSX).toContain("useIsChatHostWindow");
    expect(MOUNT_TSX).toContain(
      "if (!isChatHost && firstRunComplete !== false)",
    );
    // DockedChatOverlay wraps the mount with its own ShellControllerProvider so
    // detached windows (which lack it) can dock the chat.
    expect(MOUNT_TSX).toContain("export function DockedChatOverlay");
    expect(MOUNT_TSX).toContain("ShellControllerProvider");
    // The old three-component stack is gone: no imports, no JSX usage. (A prose
    // comment may still name them to explain the removal — assert on code, not
    // the mention.)
    expect(APP_TSX).not.toContain('from "./components/shell/HomePill"');
    expect(APP_TSX).not.toContain('from "./components/shell/AssistantOverlay"');
    expect(APP_TSX).not.toContain('from "./components/shell/ChatSurface"');
    expect(APP_TSX).not.toContain("<HomePill");
    expect(APP_TSX).not.toContain("<AssistantOverlay");
    expect(APP_TSX).not.toContain("<ChatSurface");
    expect(APP_TSX).not.toContain("ShellFoundationMount");
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
    expect(APP_TSX).toContain("<ChatOverlayMount />");
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
      'shellHistory.pushState(null, "", pathWithCurrentShellMode(path))',
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
