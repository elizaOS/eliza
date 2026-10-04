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
