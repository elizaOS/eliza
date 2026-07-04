/**
 * Pins the browser-script policy: arbitrary page.evaluate is never allowed.
 * Deterministic unit test over the policy predicate.
 */
import { describe, expect, it } from "vitest";
import {
  assertBrowserExecuteAllowed,
  BROWSER_EXECUTE_DISABLED_MESSAGE,
  BrowserExecuteDisabledError,
  isBrowserExecuteAllowed,
} from "../security/browser-script-policy.js";

describe("browser-script-policy", () => {
  it("never allows arbitrary browser script execution", () => {
    expect(isBrowserExecuteAllowed()).toBe(false);
    expect(() => assertBrowserExecuteAllowed()).toThrow(
      BrowserExecuteDisabledError,
    );
    expect(() => assertBrowserExecuteAllowed()).toThrow(
      BROWSER_EXECUTE_DISABLED_MESSAGE,
    );
  });
});
