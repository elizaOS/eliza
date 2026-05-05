import { describe, expect, it } from "vitest";
import {
  browserBridgeSafariPopupCandidates,
  normalizeSafariExtensionKey,
} from "./extension-smoke-safari.mjs";

describe("Agent Browser Bridge Safari smoke helpers", () => {
  it("normalizes Safari extension keys from the extensions plist", () => {
    expect(
      normalizeSafariExtensionKey(
        "ai.elizaos.browserbridge.extension (UNSIGNED)",
      ),
    ).toBe("ai.elizaos.browserbridge.extension");
    expect(normalizeSafariExtensionKey("com.example.Extension (TEAMID)")).toBe(
      "com.example.Extension",
    );
  });

  it("builds popup URL candidates from plist extension keys", () => {
    expect(
      browserBridgeSafariPopupCandidates([
        "ai.elizaos.browserbridge.extension (UNSIGNED)",
        "ai.elizaos.browserbridge.extension (UNSIGNED)",
      ]),
    ).toEqual([
      "safari-web-extension://ai.elizaos.browserbridge.extension/popup.html",
      "safari-web-extension://ai.elizaos.browserbridge.extension/dist/safari/popup.html",
    ]);
  });
});
