/**
 * Browser workspace script policy tests for allowed and blocked execution paths.
 */

import { describe, expect, it } from "vitest";
import {
  createDesktopBrowserWorkspaceCommandScript,
  createDesktopBrowserWorkspaceUtilityScript,
} from "../browser-workspace-desktop.js";
import {
  assertBrowserWorkspaceUserScriptAllowed,
  BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN,
  createBrowserWorkspaceJsdomScriptExecutionError,
  isBrowserWorkspaceUserScriptAllowed,
} from "../browser-workspace-helpers.js";

describe("browser workspace user script policy (GHSA-mhhr-9ph9-64j7)", () => {
  it("disallows user script on web (JSDOM) backend", () => {
    expect(() =>
      assertBrowserWorkspaceUserScriptAllowed("document.cookie", "eval", "web"),
    ).toThrow(createBrowserWorkspaceJsdomScriptExecutionError("eval").message);
  });

  it("disallows user script on desktop by default", () => {
    expect(isBrowserWorkspaceUserScriptAllowed({})).toBe(false);
    expect(() =>
      assertBrowserWorkspaceUserScriptAllowed(
        "document.cookie",
        "eval",
        "desktop",
        {},
      ),
    ).toThrow(BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN);
  });

  it("allows desktop user script only with explicit opt-in", () => {
    const env = { ELIZA_BROWSER_WORKSPACE_ALLOW_USER_SCRIPT: "1" };
    expect(isBrowserWorkspaceUserScriptAllowed(env)).toBe(true);
    expect(() =>
      assertBrowserWorkspaceUserScriptAllowed(
        "document.cookie",
        "eval",
        "desktop",
        env,
      ),
    ).not.toThrow();
  });

  it("omits new Function from generated wait script when disabled", () => {
    const script = createDesktopBrowserWorkspaceCommandScript(
      { subaction: "wait", script: "true", timeoutMs: 100 },
      {},
    );
    expect(script).not.toContain("new Function");
    expect(script).toContain("GHSA-mhhr-9ph9-64j7");
  });

  it("preserves an explicit zero vertical delta for desktop mouse scrolling", () => {
    const script = createDesktopBrowserWorkspaceUtilityScript({
      subaction: "mouse",
      mouseAction: "wheel",
      deltaX: 40,
      deltaY: 0,
      pixels: 300,
    });

    const scrollCall = script.match(/window\.scrollBy\([^)]*\)/)?.[0];
    expect(scrollCall).toBe("window.scrollBy(40, 0)");
    expect(script).toContain('axis === "y" ? window.scrollY : window.scrollX');
  });

  it("rejects non-numeric mouse deltas before generating executable script", () => {
    expect(() =>
      createDesktopBrowserWorkspaceUtilityScript({
        subaction: "mouse",
        mouseAction: "wheel",
        deltaX: "0); globalThis.marker = true; (0" as unknown as number,
      }),
    ).toThrow("deltaX must be a finite number");
  });
});
