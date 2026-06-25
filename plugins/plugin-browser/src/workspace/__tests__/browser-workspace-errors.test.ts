import { describe, expect, it } from "vitest";
import {
  assertBrowserWorkspaceConnectorSecretsNotExported,
  assertBrowserWorkspaceUrl,
  createBrowserWorkspaceCommandTargetError,
  createBrowserWorkspaceDesktopOnlyMessage,
  createBrowserWorkspaceJsdomScriptExecutionError,
  createBrowserWorkspaceNotFoundError,
} from "../browser-workspace-helpers.ts";
import {
  type BrowserWorkspaceErrorCode,
  classifyBrowserWorkspaceErrorCode,
  createBrowserWorkspaceError,
  isBrowserWorkspaceError,
  tagBrowserWorkspaceError,
} from "../browser-workspace-errors.ts";

/** Capture the Error thrown by a thunk. */
function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the thunk to throw");
}

describe("classifyBrowserWorkspaceErrorCode", () => {
  const cases: Array<[BrowserWorkspaceErrorCode, unknown]> = [
    ["invalid_url", thrown(() => assertBrowserWorkspaceUrl("not a url"))],
    ["invalid_url", thrown(() => assertBrowserWorkspaceUrl("ftp://x.test"))],
    ["tab_not_found", createBrowserWorkspaceNotFoundError("tab-1")],
    ["target_missing", createBrowserWorkspaceCommandTargetError("navigate")],
    [
      "desktop_only",
      new Error(createBrowserWorkspaceDesktopOnlyMessage("navigate")),
    ],
    [
      "script_forbidden",
      createBrowserWorkspaceJsdomScriptExecutionError("eval"),
    ],
    [
      "script_forbidden",
      createBrowserWorkspaceJsdomScriptExecutionError("wait"),
    ],
    [
      "connector_secret_export_forbidden",
      thrown(() =>
        assertBrowserWorkspaceConnectorSecretsNotExported(
          "persist:connector-gmail",
          "export-cookies",
        ),
      ),
    ],
    [
      "unknown_element_ref",
      new Error(
        "Unknown browser snapshot element ref e7. Run snapshot or inspect again before reusing element refs.",
      ),
    ],
    ["timeout", new Error("navigation timed out after 30000ms")],
    ["command_failed", new Error("something else entirely")],
    ["command_failed", "a bare string, not an Error"],
  ];

  for (const [code, error] of cases) {
    it(`maps to ${code}`, () => {
      expect(classifyBrowserWorkspaceErrorCode(error)).toBe(code);
    });
  }
});

describe("tagBrowserWorkspaceError", () => {
  it("annotates an existing Error in place, preserving message + identity", () => {
    const original = createBrowserWorkspaceNotFoundError("tab-9");
    const tagged = tagBrowserWorkspaceError(original, "navigate");
    expect(tagged).toBe(original); // same object
    expect(tagged.message).toBe(original.message); // message preserved
    expect(tagged.browserWorkspaceErrorCode).toBe("tab_not_found");
    expect(tagged.operation).toBe("navigate");
    expect(isBrowserWorkspaceError(tagged)).toBe(true);
  });

  it("is idempotent (keeps the first code/operation)", () => {
    const original = new Error("browser workspace rejected invalid URL: x");
    const once = tagBrowserWorkspaceError(original, "open");
    const twice = tagBrowserWorkspaceError(once, "navigate");
    expect(twice).toBe(once);
    expect(twice.browserWorkspaceErrorCode).toBe("invalid_url");
    expect(twice.operation).toBe("open");
  });

  it("wraps a non-Error value in a BrowserWorkspaceError", () => {
    const tagged = tagBrowserWorkspaceError("plain failure", "click");
    expect(isBrowserWorkspaceError(tagged)).toBe(true);
    expect(tagged.message).toBe("plain failure");
    expect(tagged.browserWorkspaceErrorCode).toBe("command_failed");
    expect(tagged.operation).toBe("click");
  });

  it("createBrowserWorkspaceError builds a typed error", () => {
    const e = createBrowserWorkspaceError(
      "timeout",
      "wait",
      "timed out",
      "underlying",
    );
    expect(isBrowserWorkspaceError(e)).toBe(true);
    expect(e.browserWorkspaceErrorCode).toBe("timeout");
    expect(e.operation).toBe("wait");
    expect(e.details).toBe("underlying");
  });
});
