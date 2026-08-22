/**
 * Pins the renderer shell classification every renderer-service scope decision
 * hangs off: each special window shell (companion, popout, detached, overlay,
 * tray, app window, model tester, embed) must classify as itself — never as
 * "main" — so main-scoped background services cannot leak into them.
 */
import { describe, expect, it } from "vitest";
import {
  PHONE_COMPANION_AGENT_VIEW_ID,
  type RendererShellScopeInputs,
  resolveRendererShellKind,
} from "./renderer-shell-scope";

const MAIN_INPUTS: RendererShellScopeInputs = {
  windowShellRoute: { mode: "main" },
  isPopout: false,
  isPhoneCompanion: false,
  appWindowSlug: null,
  isEmbedRoute: false,
};

describe("renderer shell scope", () => {
  it("keeps the dedicated companion renderer on its app-shell view id", () => {
    expect(PHONE_COMPANION_AGENT_VIEW_ID).toBe("phone-companion");
  });

  it("classifies the default boot as the main shell", () => {
    expect(resolveRendererShellKind(MAIN_INPUTS)).toBe("main");
  });

  it("classifies every special window shell as itself, never main", () => {
    expect(
      resolveRendererShellKind({ ...MAIN_INPUTS, isPhoneCompanion: true }),
    ).toBe("phone-companion");
    expect(resolveRendererShellKind({ ...MAIN_INPUTS, isPopout: true })).toBe(
      "popout",
    );
    expect(
      resolveRendererShellKind({
        ...MAIN_INPUTS,
        windowShellRoute: { mode: "settings" },
      }),
    ).toBe("detached");
    expect(
      resolveRendererShellKind({
        ...MAIN_INPUTS,
        windowShellRoute: { mode: "surface", tab: "chat" },
      }),
    ).toBe("detached");
    expect(
      resolveRendererShellKind({
        ...MAIN_INPUTS,
        windowShellRoute: { mode: "chat-overlay" },
      }),
    ).toBe("chat-overlay");
    expect(
      resolveRendererShellKind({
        ...MAIN_INPUTS,
        windowShellRoute: { mode: "tray-popover" },
      }),
    ).toBe("tray-popover");
    expect(
      resolveRendererShellKind({ ...MAIN_INPUTS, appWindowSlug: "notes" }),
    ).toBe("app-window");
    expect(
      resolveRendererShellKind({ ...MAIN_INPUTS, isEmbedRoute: true }),
    ).toBe("embed");
  });

  it("gives the companion and popout flags precedence over route modes", () => {
    expect(
      resolveRendererShellKind({
        ...MAIN_INPUTS,
        isPhoneCompanion: true,
        isPopout: true,
        windowShellRoute: { mode: "settings" },
      }),
    ).toBe("phone-companion");
    expect(
      resolveRendererShellKind({
        ...MAIN_INPUTS,
        isPopout: true,
        appWindowSlug: "notes",
      }),
    ).toBe("popout");
  });
});
