import { describe, expect, it } from "vitest";
import {
  lifeOpsSafariPopupCandidates,
  normalizeSafariExtensionKey,
} from "./extension-smoke-safari.mjs";

describe("LifeOps Browser Safari smoke helpers", () => {
  it("normalizes Safari extension keys from the extensions plist", () => {
    expect(
      normalizeSafariExtensionKey("ai.lifeops.browser.Extension (UNSIGNED)"),
    ).toBe("ai.lifeops.browser.Extension");
    expect(
      normalizeSafariExtensionKey("com.example.Extension (TEAMID)"),
    ).toBe("com.example.Extension");
  });

  it("builds popup URL candidates from plist extension keys", () => {
    expect(
      lifeOpsSafariPopupCandidates([
        "ai.lifeops.browser.Extension (UNSIGNED)",
        "ai.lifeops.browser.Extension (UNSIGNED)",
      ]),
    ).toEqual([
      "safari-web-extension://ai.lifeops.browser.Extension/popup.html",
      "safari-web-extension://ai.lifeops.browser.Extension/dist/safari/popup.html",
    ]);
  });
});
