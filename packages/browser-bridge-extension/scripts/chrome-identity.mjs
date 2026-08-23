/** Resolves Chrome dev identity or verifies exact Chrome Web Store release authority. */

import { createHash, createPublicKey } from "node:crypto";

export function deriveChromeExtensionId(manifestKey) {
  const der = Buffer.from(manifestKey, "base64");
  createPublicKey({ key: der, format: "der", type: "spki" });
  return [...createHash("sha256").update(der).digest().subarray(0, 16)]
    .flatMap((byte) => [byte >> 4, byte & 15])
    .map((nibble) => String.fromCharCode(97 + nibble))
    .join("");
}

export function resolveChromeExtensionIdentity({
  identity,
  release,
  env = process.env,
}) {
  if (!release) {
    if (
      deriveChromeExtensionId(identity.chromeDevManifestKey) !==
      identity.chromeDevExtensionId
    ) {
      throw new Error(
        "committed Chrome development identity does not derive exactly",
      );
    }
    return {
      extensionId: identity.chromeDevExtensionId,
      manifestKey: identity.chromeDevManifestKey,
      authority: "local_dev",
    };
  }
  const extensionId = env.ELIZA_BROWSER_BRIDGE_CHROME_STORE_ID?.trim();
  const manifestKey = env.ELIZA_BROWSER_BRIDGE_CHROME_STORE_PUBLIC_KEY?.trim();
  if (!extensionId || !/^[a-p]{32}$/.test(extensionId) || !manifestKey) {
    throw new Error(
      "Chrome release packaging requires the Web Store Item ID and Package-tab public key",
    );
  }
  if (deriveChromeExtensionId(manifestKey) !== extensionId) {
    throw new Error("Chrome Web Store Item ID does not match its public key");
  }
  return { extensionId, manifestKey, authority: "chrome_web_store" };
}
