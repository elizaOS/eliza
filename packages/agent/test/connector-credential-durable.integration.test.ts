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
 * Covers the shipped standalone/dev boot (an operator-set shared
 * `ELIZA_STATE_DIR`, restart = new process) AND the Cloud
 * container-replacement contract: the Cloud case simulates the DEPLOYED
 * env construction from `docker-sandbox-provider.ts` — each "container" is a
 * separate process whose environment is built FRESH per launch (nothing
 * copied from the previous process's env): `ELIZA_STATE_DIR` pinned to the
 * `/root/.eliza` mount (host: `${volumePath}/eliza`) and
 * `ELIZA_VAULT_PASSPHRASE` read-or-created on the agent volume by the same
 * shell command the provider runs over SSH. A negative control reproduces
 * the pre-fix defect (a fresh random passphrase per container) and must
 * fail to read. The actual production-image docker run is out of reach in
 * this harness (no container runtime); the provider-side command itself is
 * unit-proven in `docker-sandbox-utils.test.ts`.
 *
 * Boots the full runtime twice per case (~30-60s each) — kept in the
 * integration lane; run with `bun run --cwd packages/agent test:integration`
 * or target this file directly.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
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

// Google client config the way the deployment supplies it: agent settings in
// the state dir's eliza.json (runtime.getSetting deliberately never reads
// process.env). On Cloud this is the file the provider pre-seeds at
// /root/.eliza/eliza.json on the host side of the mount.
function seedElizaJson(dir: string): void {
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
              // The child fixture reads the token through runtime.getSetting,
              // so it must live here, not in the spawn env.
              DURABLE_TOKEN_VALUE: TOKEN_VALUE,
            },
          },
        ],
      },
    }),
  );
}

function newStateDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  stateDirs.push(dir);
  seedElizaJson(dir);
  return dir;
}

/**
 * A simulated per-agent host volume, laid out like the deployed
 * `/data/agents/<id>` directory: `<volume>/eliza` is what the provider bind
 * mounts at /root/.eliza (and pre-seeds eliza.json into), and
 * `<volume>/.vault-passphrase` is where it persists the vault master key.
 */
function newAgentVolume(): string {
  const volume = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-19225-volume-"));
  stateDirs.push(volume);
  fs.mkdirSync(path.join(volume, "eliza"), { recursive: true });
  seedElizaJson(path.join(volume, "eliza"));
  return volume;
}

/**
 * Construct a Cloud container environment the way the DEPLOYED provider does
 * for every launch — freshly, from the agent volume, copying nothing from a
 * previous container's env. The read-or-create shell command is the exact
 * command `buildVolumeVaultPassphraseCommand` (cloud-shared
 * docker-sandbox-utils.ts) sends over SSH; keep the two in sync.
 */
function providerConstructedCloudEnv(volume: string): Record<string, string> {
  const keyFile = path.join(volume, ".vault-passphrase");
  const q = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
  const passphrase = execFileSync("/bin/sh", [
    "-c",
    `test -s ${q(keyFile)} || { umask 077; head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \\n' > ${q(`${keyFile}.tmp`)} && mv ${q(`${keyFile}.tmp`)} ${q(keyFile)}; }; cat ${q(keyFile)}`,
  ])
    .toString()
    .trim();
  return {
    ELIZA_CLOUD_PROVISIONED: "1",
    // The provider injects ELIZA_STATE_DIR=/root/.eliza — the
    // `${volumePath}/eliza` mount. In this process-level harness the "mount"
    // is the shared host directory itself.
    ELIZA_STATE_DIR: path.join(volume, "eliza"),
    ELIZA_VAULT_PASSPHRASE: passphrase,
  };
}

function runChild(
  env: Record<string, string>,
  timeoutMs = 240_000,
): Promise<DurableResult> {
  return new Promise((resolve, reject) => {
    // The vitest parent env may carry ALLOW_NO_DATABASE (unit-lane default);
    // this e2e requires the real PGlite-backed adapter, like the deployment.
    const parentEnv = { ...process.env };
    delete parentEnv.ALLOW_NO_DATABASE;
    delete parentEnv.ELIZA_CLOUD_PROVISIONED;
    delete parentEnv.ELIZA_STATE_DIR;
    delete parentEnv.ELIZA_VAULT_PASSPHRASE;
    const child = spawn("bun", ["--conditions=eliza-source", FIXTURE], {
      cwd: path.join(HERE, ".."),
      env: {
        ...parentEnv,
        NODE_ENV: "test",
        LOG_LEVEL: "fatal",
        // Headless master-key path: no OS keychain in CI or in a Cloud
        // container; the passphrase (caller-supplied per case) derives the
        // vault key deterministically.
        ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
        // The plugin collector loads plugin-google-workspace only on an
        // explicit Google signal, and it reads this trio from process env
        // (`shouldLoadGoogleWorkspace`) — the eliza.json settings above feed
        // `runtime.getSetting`, not plugin selection.
        GOOGLE_CLIENT_ID: "durable-client",
        GOOGLE_CLIENT_SECRET: "durable-secret",
        GOOGLE_REDIRECT_URI:
          "http://127.0.0.1:39181/api/connectors/google/oauth/callback",
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

async function expectWrite(
  env: Record<string, string>,
): Promise<DurableResult> {
  const wrote = await runChild({ ...env, DURABLE_MODE: "write" });
  expect(wrote.driverError, wrote.driverError).toBeUndefined();
  expect(wrote.storeRegistered).toBe(true);
  expect(wrote.vaultRef).toBeTruthy();
  expect(wrote.accountId).toBeTruthy();
  return wrote;
}

async function expectRead(
  env: Record<string, string>,
  wrote: DurableResult,
): Promise<void> {
  const read = await runChild({
    ...env,
    DURABLE_MODE: "read",
    DURABLE_ACCOUNT_ID: wrote.accountId as string,
    DURABLE_VAULT_REF: wrote.vaultRef as string,
  });
  expect(read.driverError, read.driverError).toBeUndefined();
  expect(read.storeRegistered).toBe(true);
  // The persisted ref row survived in SQL storage…
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
    const stateDir = newStateDir("eliza-18080-durable-");
    const env = {
      ELIZA_STATE_DIR: stateDir,
      ELIZA_VAULT_PASSPHRASE: "durable-e2e-passphrase",
    };
    const wrote = await expectWrite(env);
    await expectRead(env, wrote);
  });
});

describe("connector credential durability across Cloud container replacement (#19225)", () => {
  it("write in A → replace with B over the same agent volume + newly constructed env → read in B", {
    timeout: 900_000,
  }, async () => {
    const volume = newAgentVolume();

    // Container A: env constructed the way the provider builds it at launch.
    const envA = providerConstructedCloudEnv(volume);
    const wrote = await expectWrite(envA);

    // Replace A with container B: a second, INDEPENDENT provider-style env
    // construction over the same agent volume. The stable-key contract: B's
    // read-or-create returns the key persisted by A's provision — nothing is
    // copied from A's environment.
    const envB = providerConstructedCloudEnv(volume);
    expect(envB.ELIZA_VAULT_PASSPHRASE).toBe(envA.ELIZA_VAULT_PASSPHRASE);
    await expectRead(envB, wrote);

    // Negative control — the pre-fix defect: a replacement container that
    // mints a fresh per-launch passphrase keeps the ciphertext but loses the
    // key, so the credential read MUST fail.
    const staleKeyEnv = {
      ...providerConstructedCloudEnv(volume),
      ELIZA_VAULT_PASSPHRASE: crypto.randomUUID(),
    };
    const failedRead = await runChild({
      ...staleKeyEnv,
      DURABLE_MODE: "read",
      DURABLE_ACCOUNT_ID: wrote.accountId as string,
      DURABLE_VAULT_REF: wrote.vaultRef as string,
    });
    expect(failedRead.value).toBeUndefined();
    expect(failedRead.driverError).toBeTruthy();
  });
});
