/** Verifies Chrome local identity stability and fail-closed Web Store release authority. */

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  deriveChromeExtensionId,
  resolveChromeExtensionIdentity,
} from "./chrome-identity.mjs";

const identity = JSON.parse(
  fs.readFileSync(
    path.resolve(import.meta.dirname, "../identity.json"),
    "utf8",
  ),
);

describe("Chrome extension identity", () => {
  it("keeps the committed identity explicitly local-development only", () => {
    expect(deriveChromeExtensionId(identity.chromeDevManifestKey)).toBe(
      "pmldpcoefklbdbgmggcejkfoinmjfeio",
    );
    expect(
      resolveChromeExtensionIdentity({ identity, release: false }),
    ).toMatchObject({
      extensionId: "pmldpcoefklbdbgmggcejkfoinmjfeio",
      authority: "local_dev",
    });
  });

  it("fails closed when Web Store release identity inputs are absent or mismatched", () => {
    expect(() =>
      resolveChromeExtensionIdentity({ identity, release: true, env: {} }),
    ).toThrow("Web Store Item ID");
    expect(() =>
      resolveChromeExtensionIdentity({
        identity,
        release: true,
        env: {
          ELIZA_BROWSER_BRIDGE_CHROME_STORE_ID:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          ELIZA_BROWSER_BRIDGE_CHROME_STORE_PUBLIC_KEY:
            identity.chromeDevManifestKey,
        },
      }),
    ).toThrow("does not match");
  });

  it("uses one verified store key and ID for release manifests and broker metadata", () => {
    expect(
      resolveChromeExtensionIdentity({
        identity,
        release: true,
        env: {
          ELIZA_BROWSER_BRIDGE_CHROME_STORE_ID: identity.chromeDevExtensionId,
          ELIZA_BROWSER_BRIDGE_CHROME_STORE_PUBLIC_KEY:
            identity.chromeDevManifestKey,
        },
      }),
    ).toEqual({
      extensionId: identity.chromeDevExtensionId,
      manifestKey: identity.chromeDevManifestKey,
      authority: "chrome_web_store",
    });
  });
});
