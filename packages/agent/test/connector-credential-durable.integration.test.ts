/**
 * Standalone-entrypoint durability e2e for #18080: connector credential write
 * → full process restart → credential read, over real durable state. Each
 * phase spawns the REAL standalone boot (`connector-credential-durable-child.ts`
 * → `startElizaProcess`, the same path `bin.js start` runs) as a separate
 * `bun` process sharing only a temp `ELIZA_STATE_DIR`; a restart is a
 * genuinely new OS process. Runtime, plugin resolution, host bridge (none
 * installed — the hostless default), `ConnectorCredentialStoreService` with
 * its state-dir PGlite vault, manager, and SQL storage are all real; nothing
 * on the persistence path is stubbed and no Google HTTP endpoint is touched.
 *
 * Covers the shipped standalone/dev boot and the Cloud-provisioned boot
 * (`ELIZA_CLOUD_PROVISIONED=1`, the #18080 priority topology): in both, the
 * durable store registers, the write at connect time lands in the state-dir
 * vault, and the credential is readable after restart under the same
 * `connector_credential_store` service name the credential resolver probes.
 * The vault master key comes from `ELIZA_VAULT_PASSPHRASE` (the headless
 * path a keychain-less container uses).
 *
 * Boots the full runtime twice per case (~30-60s each) — kept in the
 * integration lane; run with `bun run --cwd packages/agent test:integration`
 * or target this file directly.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(
  HERE,
  "fixtures",
  "connector-credential-durable-child.ts",
);

const TOKEN_VALUE = JSON.stringify({
  access_token: "durable-access-token",
  refresh_token: "durable-refresh-token",
  token_type: "Bearer",
});

interface DurableResult {
  mode: string;
  storeRegistered?: boolean;
  accountId?: string;
  vaultRef?: string | null;
  refs?: Array<{ credentialType: string; vaultRef: string }> | null;
  value?: string;
  driverError?: string;
  driverErrorCode?: string | null;
}

const stateDirs: string[] = [];

afterAll(() => {
  for (const dir of stateDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function newStateDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  stateDirs.push(dir);
  // Google client config the way a standalone operator supplies it: agent
  // settings in the state dir's eliza.json (runtime.getSetting deliberately
  // never reads process.env).
  fs.writeFileSync(
    path.join(dir, "eliza.json"),
    JSON.stringify({
      agents: {
        list: [
          {
            name: "Durable",
            settings: {
              GOOGLE_CLIENT_ID: "durable-client",
              GOOGLE_CLIENT_SECRET: "durable-secret",
              GOOGLE_REDIRECT_URI:
                "http://127.0.0.1:39181/api/connectors/google/oauth/callback",
            },
          },
        ],
      },
    }),
  );
  return dir;
}

function runChild(
  stateDir: string,
  env: Record<string, string>,
  timeoutMs = 240_000,
): Promise<DurableResult> {
  return new Promise((resolve, reject) => {
    // The vitest parent env may carry ALLOW_NO_DATABASE (unit-lane default);
    // this e2e requires the real PGlite-backed adapter, like the deployment.
    const parentEnv = { ...process.env };
    delete parentEnv.ALLOW_NO_DATABASE;
    delete parentEnv.ELIZA_CLOUD_PROVISIONED;
    const child = spawn("bun", ["--conditions=eliza-source", FIXTURE], {
      cwd: path.join(HERE, ".."),
      env: {
        ...parentEnv,
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        ELIZA_STATE_DIR: stateDir,
        // Headless master-key path: no OS keychain in CI or in a Cloud
        // container; the passphrase derives the vault key deterministically.
        ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
        ELIZA_VAULT_PASSPHRASE: "durable-e2e-passphrase",
        // The plugin collector loads plugin-google-workspace only on an
        // explicit Google signal, and it reads this trio from process env
        // (`shouldLoadGoogleWorkspace`) — the eliza.json settings above feed
        // `runtime.getSetting`, not plugin selection.
        GOOGLE_CLIENT_ID: "durable-client",
        GOOGLE_CLIENT_SECRET: "durable-secret",
        GOOGLE_REDIRECT_URI:
          "http://127.0.0.1:39181/api/connectors/google/oauth/callback",
        DURABLE_TOKEN_VALUE: TOKEN_VALUE,
        ...env,
      },
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(
        new Error(`child timed out after ${timeoutMs}ms\nstderr: ${stderr}`),
      );
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", () => {
      clearTimeout(timer);
      const line = stdout
        .split("\n")
        .find((candidate) => candidate.startsWith("DURABLE_RESULT="));
      if (!line) {
        reject(
          new Error(
            `child printed no DURABLE_RESULT\nstdout: ${stdout}\nstderr: ${stderr}`,
          ),
        );
        return;
      }
      resolve(JSON.parse(line.slice("DURABLE_RESULT=".length)));
    });
  });
}

async function writeRestartRead(env: Record<string, string>): Promise<void> {
  const stateDir = newStateDir("eliza-18080-durable-");

  const wrote = await runChild(stateDir, { ...env, DURABLE_MODE: "write" });
  expect(wrote.driverError, wrote.driverError).toBeUndefined();
  expect(wrote.storeRegistered).toBe(true);
  expect(wrote.vaultRef).toBeTruthy();
  expect(wrote.accountId).toBeTruthy();

  const read = await runChild(stateDir, {
    ...env,
    DURABLE_MODE: "read",
    DURABLE_ACCOUNT_ID: wrote.accountId as string,
    DURABLE_VAULT_REF: wrote.vaultRef as string,
  });
  expect(read.driverError, read.driverError).toBeUndefined();
  expect(read.storeRegistered).toBe(true);
  // The persisted ref row survived the restart in SQL storage…
  expect(read.refs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ vaultRef: wrote.vaultRef }),
    ]),
  );
  // …and the secret material it points at survived in the state-dir vault.
  expect(read.value).toBe(TOKEN_VALUE);
}

describe("connector credential durability across a real standalone restart (#18080)", () => {
  it("hostless standalone boot: write → restart → read round-trips", {
    timeout: 600_000,
  }, async () => {
    await writeRestartRead({});
  });

  it("cloud-provisioned boot (ELIZA_CLOUD_PROVISIONED=1): write → restart → read round-trips", {
    timeout: 600_000,
  }, async () => {
    await writeRestartRead({ ELIZA_CLOUD_PROVISIONED: "1" });
  });
});
