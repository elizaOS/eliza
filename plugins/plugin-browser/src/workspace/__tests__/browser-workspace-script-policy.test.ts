import { describe, expect, it } from "vitest";
import {
  assertBrowserWorkspaceUserScriptAllowed,
  BROWSER_WORKSPACE_USER_SCRIPT_FORBIDDEN,
  createBrowserWorkspaceJsdomScriptExecutionError,
  isBrowserWorkspaceUserScriptAllowed,
} from "../browser-workspace-helpers.js";
import { createDesktopBrowserWorkspaceCommandScript } from "../browser-workspace-desktop.js";

describe("browser workspace user script policy (GHSA-mhhr-9ph9-64j7)", () => {
  it("disallows user script on web (JSDOM) backend", () => {
    expect(() =>
      assertBrowserWorkspaceUserScriptAllowed(
        "document.cookie",
        "eval",
        "web",
      ),
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
});
