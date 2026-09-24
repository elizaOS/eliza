import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { PlatformSecureStore } from "../security/platform-secure-store";
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
