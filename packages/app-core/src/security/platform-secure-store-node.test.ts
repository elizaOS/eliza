/** Verifies desktop secure-store adapters and renderer boundary hardening. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createNodePlatformSecureStore,
  resolveBundledKeyringPath,
} from "./platform-secure-store-node";

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

describe("desktop platform secure-store boundary", () => {
  it("resolves one Bun-emitted native Keychain addon beside the entrypoint", () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "eliza-keyring-"));
    try {
      const entrypoint = path.join(runtimeDir, "index.js");
      const bindingPath = path.join(
        runtimeDir,
        "keyring.darwin-arm64-buildhash.node",
      );
      writeFileSync(entrypoint, "entrypoint");
      writeFileSync(bindingPath, "binding");

      expect(
        resolveBundledKeyringPath({
          arch: "arm64",
          entrypoint,
          platform: "darwin",
        }),
      ).toBe(bindingPath);
    } finally {
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("rejects ambiguous bundled native Keychain addons", () => {
    const runtimeDir = mkdtempSync(path.join(os.tmpdir(), "eliza-keyring-"));
    try {
      const entrypoint = path.join(runtimeDir, "index.js");
      writeFileSync(entrypoint, "entrypoint");
      writeFileSync(path.join(runtimeDir, "keyring.darwin-arm64-a.node"), "a");
      writeFileSync(path.join(runtimeDir, "keyring.darwin-arm64-b.node"), "b");

      expect(
        resolveBundledKeyringPath({
          arch: "arm64",
          entrypoint,
          platform: "darwin",
        }),
      ).toBeNull();
    } finally {
      rmSync(runtimeDir, { force: true, recursive: true });
    }
  });

  it("uses the cross-platform native keyring binding and never launches the security CLI", () => {
    expect(source).toContain('import("@napi-rs/keyring")');
    expect(source).not.toContain('spawn("security"');
    expect(source).not.toContain('execFileAsync("security"');
    expect(source).not.toContain('"/usr/bin/security"');
  });

  it("reports honest non-synchronizing user-session protection", () => {
    expect(source).toContain("synchronized: false");
    expect(source).toContain('access: "user_session"');
    expect(source).not.toContain(
      'store.backend === "macos_keychain" ? "app_only"',
    );
  });

  it("maps Windows to its native Credential Manager backend", () => {
    expect(source).toContain('return process.platform === "win32"');
    expect(source).toContain('"windows_credential_manager"');
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
    expect(source).toContain('verifiedMissing.reason === "not_found"');
    expect(source).toContain("{ ok: true, deleted: false }");
    expect(source).toContain("{ ok: true, deleted: true }");
    expect(source).not.toContain("// ignore — item may not exist");
    expect(source).not.toContain(
      'e.code === 1 || stderr.includes("not found")',
    );
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

  it("never returns platform stderr or swallows credential deletion failures", () => {
    expect(source).not.toContain("message: stderr");
    expect(source).toContain(
      "Native credential store deletion could not be verified.",
    );
    expect(source).not.toContain("// ignore — item may not exist");
  });

  it("round-trips Linux secrets without trimming credential bytes", () => {
    expect(source).toContain('LINUX_SECRET_WIRE_PREFIX = "eliza-v1:"');
    expect(source).toContain("encodeLinuxSecret(value)");
    expect(source).toContain("decodeLinuxSecret(value)");
    expect(source).not.toContain("stdout.trim()");
  });

  it("does not report a binary-only Linux install as an available secret service", () => {
    expect(source).toContain("linuxSecretServiceSessionReachable()");
    expect(source).toContain("process.env.DBUS_SESSION_BUS_ADDRESS");
    expect(source).toContain('path.join(runtimeDir, "bus")');
  });
});

describe("platform secure-store behavioral outcomes", () => {
  it("verifies native set, read, delete, and idempotent absence", async () => {
    const values = new Map<string, string>();
    class FakeAsyncEntry {
      constructor(
        _service: string,
        private readonly account: string,
      ) {}

      async getPassword(): Promise<string | null> {
        return values.get(this.account) ?? null;
      }

      async setPassword(value: string): Promise<void> {
        values.set(this.account, value);
      }

      async deleteCredential(): Promise<void> {
        if (!values.delete(this.account)) throw new Error("entry not found");
      }
    }
    const store = createNodePlatformSecureStore({
      platform: "darwin",
      loadNativeKeyring: async () =>
        ({
          AsyncEntry: FakeAsyncEntry,
        }) as unknown as typeof import("@napi-rs/keyring"),
    });

    await expect(
      store.set("test-vault", "session.steward_token", "ephemeral-value"),
    ).resolves.toEqual({ ok: true });
    await expect(
      store.get("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: true, value: "ephemeral-value" });
    await expect(
      store.delete("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: true, deleted: true });
    await expect(
      store.delete("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: true, deleted: false });
  });

  it("propagates native denied deletion without removing the credential", async () => {
    class DeniedAsyncEntry {
      async getPassword(): Promise<string> {
        return "retained-value";
      }
      async setPassword(): Promise<void> {}
      async deleteCredential(): Promise<void> {
        throw new Error("access denied");
      }
    }
    const store = createNodePlatformSecureStore({
      platform: "darwin",
      loadNativeKeyring: async () =>
        ({
          AsyncEntry: DeniedAsyncEntry,
        }) as unknown as typeof import("@napi-rs/keyring"),
    });

    await expect(
      store.delete("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: false, reason: "denied" });
    await expect(
      store.get("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: true, value: "retained-value" });
  });

  it("rejects native write success that cannot be read back exactly", async () => {
    class UnverifiedAsyncEntry {
      async getPassword(): Promise<null> {
        return null;
      }
      async setPassword(): Promise<void> {}
      async deleteCredential(): Promise<void> {}
    }
    const store = createNodePlatformSecureStore({
      platform: "darwin",
      loadNativeKeyring: async () =>
        ({
          AsyncEntry: UnverifiedAsyncEntry,
        }) as unknown as typeof import("@napi-rs/keyring"),
    });

    await expect(
      store.set("test-vault", "session.steward_token", "ephemeral-value"),
    ).resolves.toEqual({
      ok: false,
      reason: "error",
      message: "Native credential store write could not be verified.",
    });
  });

  it("distinguishes Linux not-found from consequential clear failure", async () => {
    const values = new Map<string, string>();
    let clearMode: "success" | "missing" | "denied" = "missing";
    const store = createNodePlatformSecureStore({
      platform: "linux",
      secretToolAvailable: async () => true,
      secretServiceReachable: () => true,
      storeSecretTool: async (args, value) => {
        values.set(args.at(-1) ?? "", value);
      },
      runSecretTool: async (_executable, args) => {
        const account = args.at(-1) ?? "";
        if (args[0] === "lookup") {
          const value = values.get(account);
          if (value === undefined) {
            throw Object.assign(new Error("missing"), { code: 1, stderr: "" });
          }
          return { stdout: value, stderr: "" };
        }
        if (clearMode === "missing") {
          throw Object.assign(new Error("missing"), { code: 1, stderr: "" });
        }
        if (clearMode === "denied") throw new Error("access denied");
        values.delete(account);
        return { stdout: "", stderr: "" };
      },
    });

    await expect(
      store.delete("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: true, deleted: false });

    await store.set("test-vault", "session.steward_token", "retained-value");
    clearMode = "denied";
    await expect(
      store.delete("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: false, reason: "denied" });
    await expect(
      store.get("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: true, value: "retained-value" });

    clearMode = "success";
    await expect(
      store.delete("test-vault", "session.steward_token"),
    ).resolves.toEqual({ ok: true, deleted: true });
  });
});
