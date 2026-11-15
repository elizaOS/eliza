/**
 * Persisted Steward credentials: a truncated/corrupt `steward-credentials.json`
 * must be reported, not silently read as "no Steward wallet configured".
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { logger } from "@elizaos/core";
import { afterEach, expect, it, vi } from "vitest";
import { initStewardWalletCache } from "../src/api/wallet.ts";

const CREDENTIALS_FILE = "steward-credentials.json";
const dirs: string[] = [];

function freshStateDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "steward-credentials-"));
  dirs.push(dir);
  return dir;
}

async function credentialErrors(stateDir: string): Promise<string[]> {
  vi.stubEnv("ELIZA_STATE_DIR", stateDir);
  // Keep the cache init off the network: without an API URL + agent id the
  // resolver returns null and never fetches, so the only observable behavior
  // is how the persisted credentials file was interpreted.
  vi.stubEnv("STEWARD_API_URL", "");
  vi.stubEnv("STEWARD_AGENT_ID", "");
  const errorSpy = vi.spyOn(logger, "error").mockImplementation(() => {});
  try {
    await initStewardWalletCache();
    return errorSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((message) => message.includes(CREDENTIALS_FILE));
  } finally {
    errorSpy.mockRestore();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

it("reports truncated persisted credentials instead of treating them as absent", async () => {
  const stateDir = freshStateDir();
  writeFileSync(
    path.join(stateDir, CREDENTIALS_FILE),
    '{"apiUrl":"https://steward.example.com","agentId":"agent-1"',
    "utf8",
  );

  const errors = await credentialErrors(stateDir);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("corrupt");
});

it("reports non-object persisted credentials instead of throwing", async () => {
  const stateDir = freshStateDir();
  writeFileSync(path.join(stateDir, CREDENTIALS_FILE), "null", "utf8");

  const errors = await credentialErrors(stateDir);

  expect(errors).toHaveLength(1);
  expect(errors[0]).toContain("corrupt");
});

it("stays silent when the credentials file is simply absent", async () => {
  const stateDir = freshStateDir();

  const errors = await credentialErrors(stateDir);

  expect(errors).toEqual([]);
});
