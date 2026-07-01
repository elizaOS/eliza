// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { KioskViewCanvas } from "./components/shell/KioskViewCanvas";
import type { KioskViewSurface } from "./components/shell/useKioskViewSurfaces";
import { readShellMode } from "./shell-mode";

/**
 * Reset the URL and the injected native global between cases so mapping tests
 * do not leak state into one another.
 */
function resetShellEnv(): void {
  window.history.replaceState({}, "", "/");
  delete window.ELIZAOS_SHELL_MODE;
}

function surface(overrides: Partial<KioskViewSurface> = {}): KioskViewSurface {
  return {
    windowId: "w-1",
    url: "http://127.0.0.1:31337/views/calendar",
    title: "Calendar",
    width: 480,
    height: 320,
    alwaysOnTop: false,
    ...overrides,
  };
}

describe("readShellMode — ?shellMode= / ?shell-mode= / global mapping", () => {
  beforeEach(resetShellEnv);
  afterEach(resetShellEnv);

  it("maps every recognized ?shellMode= value to its own mode", () => {
    const cases: Array<[string, ReturnType<typeof readShellMode>]> = [
      ["chat-overlay", "chat-overlay"],
      ["onboarding-overlay", "onboarding-overlay"],
      ["tray-popover", "tray-popover"],
      ["voice-selftest", "voice-selftest"],
      ["voice-workbench", "voice-workbench"],
      ["launcher", "launcher"],
      ["kiosk", "kiosk"],
      ["full", "full"],
    ];
    for (const [raw, expected] of cases) {
      window.history.replaceState({}, "", `/?shellMode=${raw}`);
      expect(readShellMode()).toBe(expected);
    }
  });

  it("accepts the hyphenated ?shell-mode= alias", () => {
    window.history.replaceState({}, "", "/?shell-mode=kiosk");
    expect(readShellMode()).toBe("kiosk");
  });

  it("falls back to full for an unset URL", () => {
    window.history.replaceState({}, "", "/");
    expect(readShellMode()).toBe("full");
  });

  it("falls back to full for an unknown / adversarial value", () => {
    window.history.replaceState(
      {},
      "",
      "/?shellMode=kiosk-evil%20%3Cscript%3E",
    );
    expect(readShellMode()).toBe("full");
    window.history.replaceState({}, "", "/?shellMode=KIOSK");
    expect(readShellMode()).toBe("full"); // case-sensitive by design
  });

  it("reads the ELIZAOS_SHELL_MODE global the native shell injects", () => {
    window.ELIZAOS_SHELL_MODE = "kiosk";
    expect(readShellMode()).toBe("kiosk");
  });

  it("prefers the URL param over the injected global", () => {
    window.ELIZAOS_SHELL_MODE = "kiosk";
    window.history.replaceState({}, "", "/?shellMode=chat-overlay");
    expect(readShellMode()).toBe("chat-overlay");
  });

  it("prefers ?shellMode= over the ?shell-mode= alias when both present", () => {
    window.history.replaceState(
      {},
      "",
      "/?shellMode=launcher&shell-mode=kiosk",
    );
    expect(readShellMode()).toBe("launcher");
  });

  it("parses a shellMode carried in the hash query (HashRouter case)", () => {
    window.history.replaceState({}, "", "/#/home?shellMode=tray-popover");
    expect(readShellMode()).toBe("tray-popover");
  });
});

describe("KioskViewCanvas — active-surface selection + iframe sandbox lock", () => {
  afterEach(cleanup);

  it("shows the empty prompt when no surfaces are mounted", () => {
    const { container } = render(<KioskViewCanvas surfaces={[]} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("Ask Eliza below to open something.");
  });

  it("renders exactly one iframe for a single full-bleed surface", () => {
    const { container } = render(
      <KioskViewCanvas surfaces={[surface({ windowId: "a", title: "A" })]} />,
    );
    const frames = container.querySelectorAll("iframe");
    expect(frames.length).toBe(1);
    expect(frames[0]?.getAttribute("title")).toBe("A");
  });

  it("mounts only the NEWEST full-bleed surface (last in mount order)", () => {
    const { container } = render(
      <KioskViewCanvas
        surfaces={[
          surface({ windowId: "old", title: "Old", url: "http://x/old" }),
          surface({ windowId: "new", title: "New", url: "http://x/new" }),
        ]}
      />,
    );
    const frames = container.querySelectorAll("iframe");
    expect(frames.length).toBe(1);
    expect(frames[0]?.getAttribute("title")).toBe("New");
    expect(frames[0]?.getAttribute("src")).toBe("http://x/new");
  });

  it("floating (alwaysOnTop) view wins over a full-bleed view", () => {
    const { container } = render(
      <KioskViewCanvas
        surfaces={[
          surface({ windowId: "bleed", title: "Bleed", alwaysOnTop: false }),
          surface({ windowId: "float", title: "Float", alwaysOnTop: true }),
        ]}
      />,
    );
    const frames = container.querySelectorAll("iframe");
    expect(frames.length).toBe(1);
    expect(frames[0]?.getAttribute("title")).toBe("Float");
    // Floating surface renders inside a draggable titlebar panel (the title
    // appears both in the chrome header and as the iframe title).
    expect(container.textContent).toContain("Float");
  });

  it("floating wins even when a full-bleed surface is mounted AFTER it", () => {
    const { container } = render(
      <KioskViewCanvas
        surfaces={[
          surface({ windowId: "float", title: "Float", alwaysOnTop: true }),
          surface({ windowId: "bleed", title: "Bleed", alwaysOnTop: false }),
        ]}
      />,
    );
    const frames = container.querySelectorAll("iframe");
    expect(frames.length).toBe(1);
    expect(frames[0]?.getAttribute("title")).toBe("Float");
  });

  it("locks the iframe sandbox so a view can never replace the kiosk shell", () => {
    const { container } = render(
      <KioskViewCanvas surfaces={[surface()]} />,
    );
    const frame = container.querySelector("iframe");
    const sandbox = frame?.getAttribute("sandbox") ?? "";
    const tokens = sandbox.split(/\s+/).filter(Boolean);
    // Scripts + same-origin + forms are granted (view talks to loopback agent)...
    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-same-origin");
    expect(tokens).toContain("allow-forms");
    // ...but top-navigation escape hatches are NOT granted, so the view is
    // trapped inside the kiosk canvas.
    expect(tokens).not.toContain("allow-top-navigation");
    expect(tokens).not.toContain("allow-top-navigation-by-user-activation");
    expect(tokens).not.toContain("allow-popups");
    expect(tokens).not.toContain("allow-popups-to-escape-sandbox");
  });
});
