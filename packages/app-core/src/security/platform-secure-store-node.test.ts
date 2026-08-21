import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("./platform-secure-store-node.ts", import.meta.url),
  "utf8",
);
const credentialDiscoverySource = readFileSync(
  new URL(
    "../../platforms/electrobun/src/native/credentials.ts",
    import.meta.url,
  ),
  "utf8",
);
const rendererBridgeSource = readFileSync(
  new URL("../../platforms/electrobun/src/rpc-handlers.ts", import.meta.url),
  "utf8",
);
const anthropicCredentialSource = readFileSync(
  new URL(
    "../../../../plugins/plugin-anthropic/utils/credential-store.ts",
    import.meta.url,
  ),
  "utf8",
);
const subscriptionCredentialSource = readFileSync(
  new URL("../../../auth/src/credentials.ts", import.meta.url),
  "utf8",
);

describe("macOS platform secure-store boundary", () => {
  it("uses the native keyring binding and never launches the security CLI", () => {
    expect(source).toContain('import("@napi-rs/keyring")');
    expect(source).not.toContain('spawn("security"');
    expect(source).not.toContain('execFileAsync("security"');
    expect(source).not.toContain('"/usr/bin/security"');
  });

  it("reports non-synchronizing app-only protection", () => {
    expect(source).toContain("synchronized: false");
    expect(source).toContain(
      'store.backend === "macos_keychain" ? "app_only" : "user_session"',
    );
  });

  it("does not scrape third-party Keychain entries during provider discovery", () => {
    for (const discoverySource of [
      credentialDiscoverySource,
      anthropicCredentialSource,
      subscriptionCredentialSource,
    ]) {
      expect(discoverySource).not.toContain("find-generic-password");
      expect(discoverySource).not.toContain('Bun.spawn(["security"');
      expect(discoverySource).not.toContain("Cursor Safe Storage");
      expect(discoverySource).not.toContain("copilot-keychain");
      expect(discoverySource).not.toContain("Claude Code-credentials");
    }
  });

  it("propagates native delete failures and verifies absence before success", () => {
    expect(source).toContain("Promise<SecureStoreDeleteResult>");
    expect(source).toContain("const failure = nativeStoreReason(err)");
    expect(source).toContain(
      'verifiedMissing.reason === "not_found"',
    );
    expect(source).toContain("{ ok: true, deleted: false }");
    expect(source).toContain("{ ok: true, deleted: true }");
    expect(source).not.toContain("// ignore — item may not exist");
    expect(source).not.toContain('e.code === 1 || stderr.includes("not found")');
    expect(rendererBridgeSource).toContain(
      "secureStoreDelete: async (params) =>\n      rendererSecureStore.delete(",
    );
    expect(rendererBridgeSource).not.toContain(
      "await rendererSecureStore.delete(",
    );
  });

  it("allowlists renderer slots and bounds credential payload size", () => {
    expect(rendererBridgeSource).toContain("rendererSecureStoreKinds");
    expect(rendererBridgeSource).toContain(
      "RENDERER_SECURE_STORE_MAX_VALUE_BYTES = 256 * 1024",
    );
    expect(rendererBridgeSource).toContain('Buffer.byteLength(value, "utf8")');
    expect(rendererBridgeSource).toContain(
      "requireRendererSecureStoreValue(params?.value)",
    );
  });
});
