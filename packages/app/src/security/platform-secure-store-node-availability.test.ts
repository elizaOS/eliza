/**
 * Covers the macOS/Windows native-Keychain availability probe: a host with no
 * native binding is a supported layout (callers fall back), but a binding that
 * is present and cannot load is a fault. Reporting it as "unavailable" makes
 * wallet-key hydration read nothing and look like an empty keychain.
 */
import { describe, expect, it } from "vitest";
import { createNodePlatformSecureStore } from "./platform-secure-store-node";

function loaderThrowing(error: unknown) {
  return async () => {
    throw error;
  };
}

describe("native Keychain availability probe", () => {
  it("surfaces a binding that cannot load instead of reporting no Keychain", async () => {
    const dlopenFailure = Object.assign(
      new Error(
        "dlopen(keyring.node): mach-o file, but is an incompatible architecture",
      ),
      { code: "ERR_DLOPEN_FAILED" },
    );
    const store = createNodePlatformSecureStore({
      platform: "darwin",
      loadNativeKeyring: loaderThrowing(dlopenFailure),
    });

    await expect(store.isAvailable()).rejects.toBe(dlopenFailure);
  });

  it("still reports absence when no native binding is installed", async () => {
    const notInstalled = Object.assign(
      new Error(
        "Cannot find package '@napi-rs/keyring' imported from index.js",
      ),
      { code: "ERR_MODULE_NOT_FOUND" },
    );
    const store = createNodePlatformSecureStore({
      platform: "darwin",
      loadNativeKeyring: loaderThrowing(notInstalled),
    });

    await expect(store.isAvailable()).resolves.toBe(false);
  });
});
