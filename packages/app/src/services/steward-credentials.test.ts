import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PlatformSecureStore } from "@elizaos/plugin-browser/remote-control/secure-store-contract";
import { afterEach, expect, it, vi } from "vitest";
import {
  loadStewardCredentials,
  saveStewardCredentials,
} from "./steward-credentials";

let directory: string | undefined;
afterEach(() => {
  vi.unstubAllEnvs();
  if (directory) fs.rmSync(directory, { recursive: true, force: true });
});

it("keeps the same credential vault when the state directory is addressed through a symlink", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-steward-vault-"));
  const state = path.join(directory, "state");
  const alias = path.join(directory, "alias");
  fs.mkdirSync(state);
  fs.symlinkSync(
    state,
    alias,
    process.platform === "win32" ? "junction" : "dir",
  );
  const secrets = new Map<string, string>();
  const secureStore: PlatformSecureStore = {
    backend: "none",
    isAvailable: async () => true,
    get: async (vault, kind) => {
      const value = secrets.get(`${vault}:${kind}`);
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: async (vault, kind, value) => {
      secrets.set(`${vault}:${kind}`, value);
      return { ok: true };
    },
    delete: async (vault, kind) => ({
      ok: true,
      deleted: secrets.delete(`${vault}:${kind}`),
    }),
  };
  const credentials = {
    apiUrl: "https://steward.example",
    tenantId: "tenant",
    agentId: "agent",
    apiKey: "test-key",
    agentToken: "test-token",
  };
  vi.stubEnv("ELIZA_STATE_DIR", alias);
  await saveStewardCredentials(credentials, { secureStore });
  vi.stubEnv("ELIZA_STATE_DIR", state);
  expect(await loadStewardCredentials({ secureStore })).toMatchObject(
    credentials,
  );
  const metadata = fs.readFileSync(
    path.join(state, "steward-credentials.json"),
    "utf8",
  );
  expect(metadata).not.toContain(credentials.apiKey);
  expect(metadata).not.toContain(credentials.agentToken);
  expect(secrets.size).toBe(5);
});

it("recovers an existing plaintext installation into the secure store before removing its secrets", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "steward-upgrade-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  const file = path.join(directory, "steward-credentials.json");
  const credentials = {
    apiUrl: "https://fixture.invalid",
    tenantId: "tenant",
    agentId: "agent",
    apiKey: "fixture-key",
    agentToken: "fixture-token",
  };
  fs.writeFileSync(file, JSON.stringify(credentials));
  const secrets = new Map<string, string>();
  const secureStore: PlatformSecureStore = {
    backend: "none",
    isAvailable: async () => true,
    get: async (v, k) => {
      const value = secrets.get(`${v}:${k}`);
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: async (v, k, value) => {
      secrets.set(`${v}:${k}`, value);
      return { ok: true };
    },
    delete: async () => ({ ok: true, deleted: false }),
  };
  expect(await loadStewardCredentials({ secureStore })).toMatchObject(
    credentials,
  );
  expect(fs.readFileSync(file, "utf8")).not.toContain("fixture-key");
  expect(fs.readFileSync(file, "utf8")).not.toContain("fixture-token");
});

it("retains legacy credentials and reports unavailable secure storage without claiming a configured login", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "steward-unavailable-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  const file = path.join(directory, "steward-credentials.json");
  const bytes = JSON.stringify({
    apiUrl: "https://fixture.invalid",
    tenantId: "tenant",
    agentId: "agent",
    apiKey: "fixture-key",
    agentToken: "fixture-token",
  });
  fs.writeFileSync(file, bytes);
  const secureStore = {
    backend: "none",
    isAvailable: async () => false,
  } as PlatformSecureStore;
  await expect(loadStewardCredentials({ secureStore })).rejects.toThrow(
    "retained for recovery",
  );
  expect(fs.readFileSync(file, "utf8")).toBe(bytes);
});

function legacyFixture() {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "steward-recovery-"));
  vi.stubEnv("ELIZA_STATE_DIR", directory);
  const file = path.join(directory, "steward-credentials.json");
  const credentials = {
    apiUrl: "https://fixture.invalid",
    tenantId: "tenant",
    agentId: "agent",
    apiKey: "fixture-key",
    agentToken: "fixture-token",
  };
  const bytes = JSON.stringify(credentials);
  fs.writeFileSync(file, bytes);
  const secrets = new Map<string, string>();
  const secureStore: PlatformSecureStore = {
    backend: "none",
    isAvailable: async () => true,
    get: async (_vault, kind) => {
      const value = secrets.get(kind);
      return value === undefined
        ? { ok: false, reason: "not_found" }
        : { ok: true, value };
    },
    set: vi.fn<PlatformSecureStore["set"]>(async (_vault, kind, value) => {
      secrets.set(kind, value);
      return { ok: true };
    }),
    delete: async () => ({ ok: true, deleted: false }),
  };
  return { file, bytes, credentials, secrets, secureStore };
}

it("preserves rotated secure credentials when recovering the same legacy account", async () => {
  const fixture = legacyFixture();
  fixture.secrets.set("steward.api_key", "rotated-key");
  fixture.secrets.set("steward.agent_token", "rotated-token");
  expect(await loadStewardCredentials(fixture)).toMatchObject({
    ...fixture.credentials,
    apiKey: "rotated-key",
    agentToken: "rotated-token",
  });
  expect(fixture.secrets.get("steward.api_key")).toBe("rotated-key");
  expect(fs.readFileSync(fixture.file, "utf8")).not.toContain("fixture-key");
});

it("retains the file after a partial copy and safely completes a retry", async () => {
  const fixture = legacyFixture();
  const set = fixture.secureStore.set;
  fixture.secureStore.set = async (vault, kind, value) => {
    if (kind === "steward.agent_token")
      throw new Error("fixture write failure");
    return set(vault, kind, value);
  };
  await expect(loadStewardCredentials(fixture)).rejects.toThrow(
    "fixture write failure",
  );
  expect(fs.readFileSync(fixture.file, "utf8")).toBe(fixture.bytes);
  fixture.secrets.set("steward.api_key", "rotated-after-interruption");
  fixture.secureStore.set = set;
  expect(await loadStewardCredentials(fixture)).toMatchObject({
    ...fixture.credentials,
    apiKey: "rotated-after-interruption",
  });
  expect(fs.readFileSync(fixture.file, "utf8")).not.toContain("fixture-token");
});

it("does not copy legacy secrets into another secure-store account", async () => {
  const fixture = legacyFixture();
  fixture.secrets.set("steward.agent_id", "different-agent");
  await expect(loadStewardCredentials(fixture)).rejects.toThrow(
    "retained for recovery",
  );
  expect(fixture.secureStore.set).not.toHaveBeenCalled();
  expect(fs.readFileSync(fixture.file, "utf8")).toBe(fixture.bytes);
});

it("does not treat a failed secure-store read as an absent secret", async () => {
  const fixture = legacyFixture();
  fixture.secureStore.get = async () => {
    throw new Error("fixture read failure");
  };
  await expect(loadStewardCredentials(fixture)).rejects.toThrow(
    "fixture read failure",
  );
  expect(fixture.secureStore.set).not.toHaveBeenCalled();
  expect(fs.readFileSync(fixture.file, "utf8")).toBe(fixture.bytes);
});
