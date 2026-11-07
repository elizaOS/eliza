import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { AuthStore } from "../../services/auth-store";
import { runDevWalletLogin, runElizaAuthReset } from "./register.auth";

const ENV_KEYS = [
  "ELIZA_STATE_DIR",
  "ELIZA_CONFIG_PATH",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZAOS_CLOUD_API_KEY",
  "ELIZAOS_CLOUD_ENABLED",
] as const;
let root: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  root = mkdtempSync(path.join(os.tmpdir(), "eliza-auth-cli-"));
  process.env.ELIZA_STATE_DIR = path.join(root, "state");
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(root, { recursive: true, force: true });
});

const CHALLENGE = "a".repeat(64);

it("tells the operator to write the proof while the command waits, not to re-run it", async () => {
  const lines: string[] = [];
  const result = await runElizaAuthReset({
    env: { ELIZA_API_BIND: "127.0.0.1" },
    log: (line) => lines.push(line),
    challenge: CHALLENGE,
    proofReader: async () => null,
    proofPollIntervalMs: 1,
    proofTimeoutMs: 5,
  });
  const text = lines.join("\n");
  expect(result).toMatchObject({ ok: false, reason: "proof_failed" });
  expect(text).not.toMatch(/then re-run this command/);
  expect(text).toMatch(/Keep this command running/);
  expect(result.message).toMatch(/NEW token/);
});

it("returns a structured proof failure when the proof file cannot be read", async () => {
  const result = await runElizaAuthReset({
    env: { ELIZA_API_BIND: "127.0.0.1" },
    log: () => {},
    challenge: CHALLENGE,
    proofReader: async () => {
      throw new Error("permission denied");
    },
    proofPollIntervalMs: 1,
    proofTimeoutMs: 3,
  });
  expect(result).toMatchObject({ ok: false, reason: "proof_failed" });
});

it("closes the store it was handed even when session revocation fails", async () => {
  const cleanup = vi.fn(async () => {});
  const store = {
    listIdentitiesByKind: vi.fn(async () => {
      throw new Error("db down");
    }),
  } as unknown as AuthStore;
  await expect(
    runElizaAuthReset({
      env: { ELIZA_API_BIND: "127.0.0.1" },
      log: () => {},
      challenge: CHALLENGE,
      proofReader: async () => CHALLENGE,
      store,
      cleanup,
      skipProofCleanup: true,
    }),
  ).rejects.toThrow("db down");
  expect(cleanup).toHaveBeenCalledTimes(1);
});

it("dev-login persists the minted key through saveElizaConfig (0600)", async () => {
  const fetchImpl = vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.includes("/siwe/nonce")) {
      return Response.json({
        nonce: "n0nce1234567",
        domain: "api.example.test",
        uri: "https://api.example.test",
      });
    }
    return Response.json({ apiKey: "ek-test", address: "0xabc" });
  }) as unknown as typeof fetch;
  const result = await runDevWalletLogin({
    cloudApiBase: "https://api.example.test",
    privateKey: `0x${"11".repeat(32)}`,
    log: () => {},
    fetchImpl,
  });
  const configPath = path.join(root, "state", "eliza.json");
  expect(result).toMatchObject({ ok: true, savedTo: configPath });
  expect(JSON.parse(readFileSync(configPath, "utf8")).env).toMatchObject({
    ELIZAOS_CLOUD_API_KEY: "ek-test",
    ELIZAOS_CLOUD_ENABLED: "true",
  });
  if (process.platform !== "win32") {
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  }
});
