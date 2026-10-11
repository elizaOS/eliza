import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { startApiServer as startApiServerType } from "@elizaos/agent";
import { createTestVault, type TestVault } from "@elizaos/auth/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { _resetSharedVaultForTesting } from "../services/vault-mirror";
import { startApiServer } from "./server";

const ENV_KEYS = [
  "ELIZA_API_BIND",
  "ELIZA_API_TOKEN",
  "ELIZA_CONFIG_PATH",
  "ELIZA_DISABLE_AUTO_API_TOKEN",
  "ELIZA_PERSIST_CONFIG_PATH",
  "ELIZA_REQUIRE_LOCAL_AUTH",
  "ELIZA_STATE_DIR",
  "OPENAI_API_KEY",
] as const;

const OWNER_TOKEN = "inventory-delete-owner-token";
const SECRET_KEY = "OPENAI_API_KEY";
const SECRET_REF = `vault://${SECRET_KEY}`;
const SECRET_VALUE = "test-placeholder-not-a-real-key";

type ApiServer = Awaited<ReturnType<typeof startApiServerType>>;

let savedEnv: Record<(typeof ENV_KEYS)[number], string | undefined>;
let directory = "";
let configPath = "";
let vault: TestVault;
let server: ApiServer | null = null;
let baseUrl = "";

function request(pathname: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: { authorization: `Bearer ${OWNER_TOKEN}`, ...init.headers },
  });
}

async function secretStatus(): Promise<boolean | undefined> {
  const response = await request("/api/secrets");
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    secrets: Array<{ key: string; isSet: boolean }>;
  };
  return body.secrets.find((entry) => entry.key === SECRET_KEY)?.isSet;
}

describe("DELETE /api/secrets/inventory/:key", { concurrent: false }, () => {
  beforeAll(async () => {
    savedEnv = Object.fromEntries(
      ENV_KEYS.map((key) => [key, process.env[key]]),
    ) as Record<(typeof ENV_KEYS)[number], string | undefined>;
    directory = await mkdtemp(path.join(tmpdir(), "eliza-inventory-delete-"));
    configPath = path.join(directory, "eliza.json");
    await writeFile(
      configPath,
      JSON.stringify({
        env: { [SECRET_KEY]: SECRET_REF, vars: { [SECRET_KEY]: SECRET_REF } },
        plugins: {
          entries: { openai: { config: { [SECRET_KEY]: SECRET_REF } } },
        },
      }),
    );
    process.env.ELIZA_STATE_DIR = directory;
    process.env.ELIZA_CONFIG_PATH = configPath;
    process.env.ELIZA_PERSIST_CONFIG_PATH = configPath;
    process.env.ELIZA_API_BIND = "127.0.0.1";
    process.env.ELIZA_REQUIRE_LOCAL_AUTH = "1";
    process.env.ELIZA_DISABLE_AUTO_API_TOKEN = "1";
    process.env.ELIZA_API_TOKEN = OWNER_TOKEN;
    process.env[SECRET_KEY] = SECRET_VALUE;

    vault = await createTestVault({
      secrets: { [SECRET_KEY]: SECRET_VALUE },
    });
    _resetSharedVaultForTesting(vault.vault);

    server = await startApiServer({ port: 0, skipDeferredStartupWork: true });
    baseUrl = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    await server?.close();
    server = null;
    _resetSharedVaultForTesting(null);
    await vault?.dispose();
    await rm(directory, { recursive: true, force: true });
    for (const key of ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("removes the deleted key's vault references from the live and saved config", async () => {
    expect(await secretStatus()).toBe(true);

    const deleted = await request(`/api/secrets/inventory/${SECRET_KEY}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(await vault.vault.has(SECRET_KEY)).toBe(false);

    expect(await secretStatus()).toBe(false);
    expect(process.env[SECRET_KEY]).toBeUndefined();
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      env: { vars: {} },
      plugins: { entries: { openai: { config: {} } } },
    });
    expect(await readFile(configPath, "utf8")).not.toContain(SECRET_REF);
  });
});
