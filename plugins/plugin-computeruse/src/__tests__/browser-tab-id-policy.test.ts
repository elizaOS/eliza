/**
 * Browser tab IDs are positional decimal indices. These tests exercise the
 * shared service/platform policy and the two destructive platform exports
 * without launching Puppeteer.
 */

import { ElizaError } from "@elizaos/core";
import { describe, expect, it } from "vitest";
import { closeBrowserTab, switchBrowserTab } from "../platform/browser.js";
import {
  INVALID_BROWSER_TAB_ID_MESSAGE,
  InvalidBrowserTabIdError,
  normalizeBrowserTabId,
} from "../security/browser-tab-id-policy.js";

describe("normalizeBrowserTabId", () => {
  it.each([
    ["0", "0"],
    ["1", "1"],
    [Number.MAX_SAFE_INTEGER.toString(), Number.MAX_SAFE_INTEGER.toString()],
    [0, "0"],
    [1, "1"],
    [Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER.toString()],
  ])("normalizes canonical tab ID %j", (input, expected) => {
    expect(normalizeBrowserTabId(input)).toBe(expected);
  });

  it.each([
    undefined,
    null,
    "",
    " ",
    " 1 ",
    "+1",
    "-0",
    "-1",
    "01",
    "1.0",
    "1e1",
    "0x1",
    "1junk",
    (Number.MAX_SAFE_INTEGER + 1).toString(),
    -0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    {},
  ])("rejects malformed tab ID %j", (input) => {
    expect(() => normalizeBrowserTabId(input)).toThrow(
      InvalidBrowserTabIdError,
    );
    expect(() => normalizeBrowserTabId(input)).toThrow(
      INVALID_BROWSER_TAB_ID_MESSAGE,
    );
  });

  it("uses the repository's typed domain error contract", () => {
    let thrown: unknown;
    try {
      normalizeBrowserTabId("1junk");
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ElizaError);
    expect(thrown).toMatchObject({
      name: "InvalidBrowserTabIdError",
      code: "COMPUTER_USE_BROWSER_TAB_ID_INVALID",
    });
  });
});

describe("browser tab platform boundaries", () => {
  it.each([
    ["close", closeBrowserTab],
    ["switch", switchBrowserTab],
  ] as const)(
    "rejects a malformed ID before attempting to %s a tab",
    async (_, action) => {
      await expect(action("1junk")).rejects.toThrow(InvalidBrowserTabIdError);
    },
  );
});
