/**
 * Real Bun and Node child processes prove runner argv/environment signals and
 * the removed global bypass cannot alter explicit storage ownership.
 */

import { spawn, spawnSync } from "node:child_process";
import fs, { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createIsolatedAccountStoragePolicy,
  loadAccount,
  resetAccountCredentialStorage,
  saveAccount,
} from "./account-storage.ts";

const probe = fileURLToPath(
  new URL(
    "../../test/fixtures/account-storage-subprocess-probe.ts",
    import.meta.url,
  ),
);
let container: string;

beforeEach(() => {
  container = mkdtempSync(path.join(tmpdir(), "eliza-storage-process-"));
});

afterEach(() => {
  rmSync(container, { recursive: true, force: true });
});

function runProbe(
  runtime: "bun" | "node-test",
  signals: Record<string, string>,
  root = path.join(container, runtime),
) {
  fs.mkdirSync(root, { recursive: true });
  const resultFile = path.join(container, `${runtime}-result.json`);
  const command = runtime === "bun" ? "bun" : process.execPath;
  const args =
    runtime === "bun"
      ? ["--conditions=eliza-source", probe, "vitest", "bun test", "turbo"]
      : [
          "--test",
          "--import",
          "tsx",
          "--conditions=eliza-source",
          probe,
          "--",
          "vitest",
          "bun test",
          "turbo",
        ];
  const child = spawnSync(command, args, {
    cwd: path.resolve(import.meta.dirname, "../../../.."),
    encoding: "utf8",
    env: {
      ...process.env,
      ...signals,
      ELIZA_ALLOW_REAL_STATE_IN_TESTS: "1",
      ELIZA_STORAGE_PROBE_RESULT: resultFile,
      ELIZA_STORAGE_PROBE_ROOT: root,
    },
  });
  return {
    child,
    result: fs.existsSync(resultFile)
      ? (JSON.parse(fs.readFileSync(resultFile, "utf8")) as Record<
          string,
          unknown
        >)
      : null,
  };
}

function runtimeInvocation(runtime: "bun" | "node-test"): {
  args: string[];
  command: string;
} {
  return runtime === "bun"
    ? {
        args: ["--conditions=eliza-source", probe],
        command: "bun",
      }
    : {
        args: ["--test", "--import", "tsx", "--conditions=eliza-source", probe],
        command: process.execPath,
      };
}

describe("account storage subprocess ownership", () => {
  it.each([
    ["bun", { BUN_ENV: "test" }],
    ["node-test", { NODE_ENV: "test", VITEST: "true", TURBO_HASH: "signal" }],
  ] as const)(
    "uses explicit isolated authority under %s",
    (runtime, signals) => {
      const { child, result } = runProbe(runtime, signals);
      expect(child.status, child.stderr).toBe(0);
      expect(result).toEqual({
        ok: true,
        owner: "isolated-test",
        remaining: false,
      });
    },
  );

  it("does not let an inherited global bypass authorize a symlink root", () => {
    const linkedRoot = path.join(container, "linked-root");
    symlinkSync(path.parse(container).root, linkedRoot, "dir");
    const { child, result } = runProbe(
      "bun",
      { VITEST: "true", TURBO_HASH: "signal" },
      linkedRoot,
    );

    expect(child.status, child.stderr).toBe(0);
    expect(result).toEqual({
      ok: false,
      code: "AUTH_CREDENTIAL_ISOLATED_ROOT_REQUIRED",
    });
  });

  it.each(["bun", "node-test"] as const)(
    "fences a stale %s writer that races a full reset",
    async (runtime) => {
      const root = path.join(container, `${runtime}-race`);
      fs.mkdirSync(root, { recursive: true });
      const resultFile = path.join(container, `${runtime}-race-result.json`);
      const readyFile = path.join(container, `${runtime}-race-ready`);
      const goFile = path.join(container, `${runtime}-race-go`);
      const invocation = runtimeInvocation(runtime);
      const child = spawn(invocation.command, invocation.args, {
        cwd: path.resolve(import.meta.dirname, "../../../.."),
        env: {
          ...process.env,
          ELIZA_STORAGE_PROBE_GO: goFile,
          ELIZA_STORAGE_PROBE_MODE: "reset-race",
          ELIZA_STORAGE_PROBE_READY: readyFile,
          ELIZA_STORAGE_PROBE_RESULT: resultFile,
          ELIZA_STORAGE_PROBE_ROOT: root,
        },
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stderr: Buffer[] = [];
      child.stderr?.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
      // Node's test reporter may buffer stdout until the probe exits. The
      // ready file is the barrier; reporter output is not a readiness signal.
      child.stdout?.resume();
      let closed = false;
      let spawnError: Error | undefined;
      child.once("error", (error) => {
        spawnError = error;
      });
      const childDone = new Promise<void>((resolve) => {
        child.once("close", () => {
          closed = true;
          resolve();
        });
      });
      const diagnostics = () =>
        `${runtime} pid=${child.pid ?? "not spawned"} exit=${child.exitCode} signal=${child.signalCode}: ${spawnError?.message ?? Buffer.concat(stderr).toString("utf8")}`;
      const waitFor = async (ready: () => boolean, phase: string) => {
        const deadline = Date.now() + 10_000;
        while (!ready()) {
          if (spawnError || closed) {
            throw new Error(`child exited before ${phase}: ${diagnostics()}`);
          }
          if (Date.now() >= deadline) {
            throw new Error(`child did not reach ${phase}: ${diagnostics()}`);
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      };
      const reapChild = async () => {
        // Reap the test runner and its probe before afterEach removes storage.
        if (!closed && child.pid !== undefined) {
          if (process.platform === "win32") {
            const stopped = spawnSync(
              "taskkill",
              ["/pid", String(child.pid), "/T", "/F"],
              { encoding: "utf8" },
            );
            if (stopped.error) throw stopped.error;
            if (stopped.status !== 0)
              throw new Error(`failed to reap probe: ${stopped.stderr}`);
          } else {
            try {
              process.kill(-child.pid, "SIGKILL");
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ESRCH")
                throw error;
            }
          }
        }
        await childDone;
      };
      try {
        await waitFor(() => fs.existsSync(readyFile), "reset race barrier");
        const policy = createIsolatedAccountStoragePolicy(root);
        resetAccountCredentialStorage(policy, () => {
          fs.writeFileSync(goFile, "go");
          Atomics.wait(
            new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
            0,
            0,
            150,
          );
        });

        await waitFor(() => closed, "probe completion");
        expect(child.exitCode, diagnostics()).toBe(0);
        expect(JSON.parse(fs.readFileSync(resultFile, "utf8"))).toEqual({
          code: "AUTH_CREDENTIAL_STORAGE_GENERATION_CHANGED",
          ok: false,
        });
        expect(
          fs.existsSync(
            path.join(root, "auth", "openai-codex", "child-account.json"),
          ),
        ).toBe(false);
      } finally {
        await reapChild();
      }
    },
    20_000,
  );
});

it("resolves the production master key once per list and observes changed authority on the next list", () => {
  const source = new URL("./account-storage.ts", import.meta.url).href;
  const root = path.join(container, "batch-key");
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "--conditions=eliza-source",
      "--input-type=module",
      "--eval",
      `import crypto from "node:crypto";
     import { syncBuiltinESMExports } from "node:module";
     const derive = crypto.scryptSync;
     let calls = 0;
     crypto.scryptSync = (...args) => { calls++; return derive(...args); };
     syncBuiltinESMExports();
     const storage = await import(${JSON.stringify(source)});
     const policy = storage.createRuntimeAccountStoragePolicy(${JSON.stringify(root)});
     for (let i = 0; i < 3; i++) storage.saveAccount({
       id: "account-" + i, providerId: "openai-codex", label: "Account",
       source: "oauth", credentials: { access: "test-access", refresh: "test-refresh", expires: 9999999999999 },
       createdAt: i, updatedAt: i,
     }, policy);
     calls = 0;
     const records = storage.listAccounts("openai-codex", policy);
     if (records.length !== 3 || calls !== 1) throw new Error("batch did not resolve exactly once: " + calls);
     process.env.ELIZA_VAULT_PASSPHRASE = "changed-test-passphrase";
     let rejected = false;
     try { storage.listAccounts("openai-codex", policy); } catch (e) {
       rejected = e.code === "AUTH_CREDENTIAL_RECORD_CORRUPT";
     }
     if (!rejected || calls !== 2) throw new Error("stale master key survived the operation");
     console.log("batch-key-ok");`,
    ],
    {
      cwd: path.resolve(import.meta.dirname, "../../../.."),
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_ENV: "production",
        BUN_ENV: "production",
        VITEST: "false",
        ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
        ELIZA_VAULT_PASSPHRASE: "initial-test-passphrase",
      },
      timeout: 60_000,
    },
  );
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("batch-key-ok");
});

it("retires a partially published lock when owner fsync fails", () => {
  const root = path.join(container, "acquire-failure");
  const policy = createIsolatedAccountStoragePolicy(root);
  const record = {
    id: "lock-retry",
    providerId: "openai-codex" as const,
    label: "Lock retry",
    source: "oauth" as const,
    credentials: {
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 9_999_999_999_999,
    },
    createdAt: 1,
    updatedAt: 1,
  };
  const originalOpen = fs.openSync;
  const originalFsync = fs.fsyncSync;
  const ownerDescriptors = new Set<number>();
  let injected = false;
  try {
    fs.openSync = ((
      file: fs.PathLike,
      flags: string | number,
      mode?: fs.Mode,
    ) => {
      const descriptor = originalOpen(file, flags, mode);
      if (
        String(file).endsWith(
          `${path.sep}.credential-storage.lock${path.sep}owner.json`,
        )
      ) {
        ownerDescriptors.add(descriptor);
      }
      return descriptor;
    }) as typeof fs.openSync;
    fs.fsyncSync = (descriptor: number) => {
      if (!injected && ownerDescriptors.has(descriptor)) {
        injected = true;
        throw Object.assign(new Error("injected owner fsync failure"), {
          code: "EIO",
        });
      }
      originalFsync(descriptor);
    };
    expect(() => saveAccount(record, policy)).toThrow(
      "injected owner fsync failure",
    );
  } finally {
    fs.openSync = originalOpen;
    fs.fsyncSync = originalFsync;
  }
  expect(injected).toBe(true);
  expect(
    fs.existsSync(path.join(policy.authRoot, ".credential-storage.lock")),
  ).toBe(false);
  saveAccount(record, policy);
  expect(
    loadAccount(record.providerId, record.id, policy)?.credentials.access,
  ).toBe("fixture-access");
  const envelope = JSON.parse(
    fs.readFileSync(
      path.join(policy.authRoot, record.providerId, `${record.id}.json`),
      "utf8",
    ),
  );
  expect(envelope.schemaVersion).toBe(2);
});

const ownershipProbe = fileURLToPath(
  new URL("../../test/fixtures/storage-ownership-probe.ts", import.meta.url),
);

function startOwnershipProbe(root: string, mode: string) {
  const child = spawn("bun", ["--conditions=eliza-source", ownershipProbe], {
    cwd: path.resolve(import.meta.dirname, "../../../.."),
    env: {
      ...process.env,
      NODE_ENV: "production",
      BUN_ENV: "production",
      VITEST: "false",
      ELIZA_VAULT_DISABLE_KEYCHAIN: "1",
      ELIZA_VAULT_PASSPHRASE: "isolated-storage-regression-passphrase",
      STORAGE_PROBE_ROOT: root,
      STORAGE_PROBE_MODE: mode,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stdout.resume();
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0 || signal === "SIGKILL") resolve();
      else reject(new Error(`${mode} exited ${code}: ${stderr}`));
    });
  });
  return { child, done, root, mode };
}

type OwnershipProbe = ReturnType<typeof startOwnershipProbe>;

async function waitForOwnershipBarrier(probe: OwnershipProbe, name: string) {
  const deadline = performance.now() + 40_000;
  while (!fs.existsSync(path.join(probe.root, name))) {
    if (probe.child.exitCode !== null || performance.now() > deadline) {
      throw new Error(`Missing ${name} for ${probe.mode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function finishOwnershipProbe(probe: OwnershipProbe) {
  await probe.done;
  return JSON.parse(
    fs.readFileSync(path.join(probe.root, `${probe.mode}-result.json`), "utf8"),
  ) as { ok: boolean; code?: string; ids?: string[]; revivedToken?: boolean };
}

async function stopOwnershipProbe(probe: OwnershipProbe) {
  if (probe.child.exitCode === null && probe.child.signalCode === null) {
    probe.child.kill("SIGKILL");
  }
  await probe.done;
}

it.each(["reset-first-file", "reset-callback", "reset-generation"])(
  "fences a pending writer after %s process death and recovers on restart",
  async (mode) => {
    const root = path.join(container, mode);
    fs.mkdirSync(root);
    expect(
      await finishOwnershipProbe(startOwnershipProbe(root, "seed")),
    ).toEqual({ ok: true });
    const writer = startOwnershipProbe(root, "writer");
    await waitForOwnershipBarrier(writer, "writer-ready");
    const reset = startOwnershipProbe(root, mode);
    try {
      await waitForOwnershipBarrier(reset, "reset-ready");
      await stopOwnershipProbe(reset);
      if (mode === "reset-first-file") {
        expect(
          await finishOwnershipProbe(startOwnershipProbe(root, "read")),
        ).toEqual({
          ok: true,
          ids: [],
          revivedToken: false,
        });
      }
      fs.writeFileSync(path.join(root, "writer-go"), "go");
      expect(await finishOwnershipProbe(writer)).toMatchObject({
        ok: false,
        code: "AUTH_CREDENTIAL_STORAGE_GENERATION_CHANGED",
      });
      expect(
        await finishOwnershipProbe(startOwnershipProbe(root, "read")),
      ).toEqual({
        ok: true,
        ids: [],
        revivedToken: false,
      });
      const callbackFile = path.join(root, "callback-count");
      expect(
        fs.existsSync(callbackFile)
          ? fs.readFileSync(callbackFile, "utf8")
          : "",
      ).toBe(mode === "reset-first-file" ? "" : "1");
      expect(
        fs
          .readFileSync(
            path.join(root, "auth", ".credential-storage-generation"),
            "utf8",
          )
          .trim(),
      ).toBe("1");
      expect(
        fs.existsSync(path.join(root, "auth", ".credential-storage-reset")),
      ).toBe(false);
    } finally {
      await stopOwnershipProbe(writer);
      await stopOwnershipProbe(reset);
    }
  },
);

it("retains a live successor when a stale lock observation is renamed", async () => {
  const root = path.join(container, "stale-reaper");
  fs.mkdirSync(root);
  const dead = startOwnershipProbe(root, "dead");
  let reaper: OwnershipProbe | undefined;
  let holder: OwnershipProbe | undefined;
  try {
    await waitForOwnershipBarrier(dead, "dead-ready");
    await stopOwnershipProbe(dead);
    reaper = startOwnershipProbe(root, "reaper");
    await waitForOwnershipBarrier(reaper, "reaper-observed");
    holder = startOwnershipProbe(root, "holder");
    await waitForOwnershipBarrier(holder, "holder-ready");
    fs.writeFileSync(path.join(root, "reaper-rename"), "go");
    // The stale observer has moved the live lock. Its live quarantine must
    // block admission until the original callback and release finish.
    await waitForOwnershipBarrier(reaper, "reaper-renamed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(path.join(root, "reaper-ready"))).toBe(false);
    fs.writeFileSync(path.join(root, "holder-go"), "go");
    await waitForOwnershipBarrier(holder, "holder-release-unlinked");
    await waitForOwnershipBarrier(reaper, "reaper-ready");
    fs.writeFileSync(path.join(root, "holder-release-go"), "go");
    expect(await finishOwnershipProbe(holder)).toEqual({ ok: true });
    fs.writeFileSync(path.join(root, "reaper-go"), "go");
    expect(await finishOwnershipProbe(reaper)).toEqual({ ok: true });
    expect(
      await finishOwnershipProbe(startOwnershipProbe(root, "read")),
    ).toEqual({
      ok: true,
      ids: ["holder", "reaper"],
      revivedToken: false,
    });
  } finally {
    await stopOwnershipProbe(dead);
    if (reaper) await stopOwnershipProbe(reaper);
    if (holder) await stopOwnershipProbe(holder);
  }
});

it("restores complete encrypted artifacts when the one-shot reset callback fails", () => {
  const policy = createIsolatedAccountStoragePolicy(
    path.join(container, "rollback"),
  );
  const record = {
    id: "rollback-account",
    providerId: "openai-codex" as const,
    label: "Complete identity",
    source: "oauth" as const,
    credentials: {
      access: "fixture-access",
      refresh: "fixture-refresh",
      expires: 9_999_999_999_999,
    },
    organizationId: "fixture-org",
    userId: "fixture-user",
    email: "fixture@example.test",
    createdAt: 1,
    updatedAt: 1,
  };
  const stored = saveAccount(record, policy);
  const file = path.join(
    policy.authRoot,
    record.providerId,
    `${record.id}.json`,
  );
  const before = fs.readFileSync(file);
  let calls = 0;
  expect(() =>
    resetAccountCredentialStorage(policy, () => {
      calls++;
      throw new Error("host mutation failed");
    }),
  ).toThrow("Credential reset failed");
  expect(calls).toBe(1);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(loadAccount(record.providerId, record.id, policy)).toEqual(stored);
  expect(
    fs.existsSync(path.join(policy.authRoot, ".credential-storage-reset")),
  ).toBe(false);
});

it.skipIf(process.platform === "win32")(
  "keeps a published reset generation fenced when its directory fsync fails",
  () => {
    const root = path.join(container, "uncertain-generation");
    const policy = createIsolatedAccountStoragePolicy(root);
    saveAccount(
      {
        id: "before",
        providerId: "openai-codex",
        label: "Before",
        source: "oauth",
        credentials: {
          access: "fixture-access",
          refresh: "fixture-refresh",
          expires: 9_999_999_999_999,
        },
        createdAt: 1,
        updatedAt: 1,
      },
      policy,
    );
    const originalRename = fs.renameSync;
    const originalFsync = fs.fsyncSync;
    let publication = false;
    let failed = false;
    let calls = 0;
    try {
      fs.renameSync = (from, to) => {
        originalRename(from, to);
        if (String(to).endsWith(".credential-storage-generation"))
          publication = true;
      };
      fs.fsyncSync = (descriptor) => {
        if (publication && !failed) {
          failed = true;
          throw Object.assign(new Error("injected publication fsync failure"), {
            code: "EIO",
          });
        }
        originalFsync(descriptor);
      };
      expect(() =>
        resetAccountCredentialStorage(policy, () => {
          calls++;
        }),
      ).toThrow(
        "Credential reset advanced its generation but did not confirm completion",
      );
    } finally {
      fs.renameSync = originalRename;
      fs.fsyncSync = originalFsync;
    }
    expect(failed).toBe(true);
    const restarted = createIsolatedAccountStoragePolicy(root);
    expect(loadAccount("openai-codex", "before", restarted)).toBeNull();
    expect(calls).toBe(1);
    expect(() => loadAccount("openai-codex", "before", policy)).toThrow(
      "Credential storage policy predates the latest reset",
    );
  },
);

it("rejects malformed reset intent before changing encrypted artifacts", () => {
  const root = path.join(container, "malformed-intent");
  const policy = createIsolatedAccountStoragePolicy(root);
  saveAccount(
    {
      id: "preserved",
      providerId: "openai-codex",
      label: "Preserved",
      source: "oauth",
      credentials: {
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 9_999_999_999_999,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
  );
  const file = path.join(policy.authRoot, "openai-codex", "preserved.json");
  const before = fs.readFileSync(file);
  fs.writeFileSync(
    path.join(policy.authRoot, ".credential-storage-reset"),
    "{",
  );
  expect(() => createIsolatedAccountStoragePolicy(root)).toThrow(
    "Credential reset recovery intent is malformed",
  );
  expect(fs.readFileSync(file)).toEqual(before);
});

it("retries reset recovery after the recovering process dies during deletion", async () => {
  const root = path.join(container, "interrupted-recovery");
  fs.mkdirSync(root);
  expect(await finishOwnershipProbe(startOwnershipProbe(root, "seed"))).toEqual(
    { ok: true },
  );
  const reset = startOwnershipProbe(root, "reset-first-file");
  let recovery: OwnershipProbe | undefined;
  try {
    await waitForOwnershipBarrier(reset, "reset-ready");
    await stopOwnershipProbe(reset);
    recovery = startOwnershipProbe(root, "recover-first-file");
    await waitForOwnershipBarrier(recovery, "recovery-ready");
    await stopOwnershipProbe(recovery);
    expect(
      await finishOwnershipProbe(startOwnershipProbe(root, "read")),
    ).toEqual({
      ok: true,
      ids: [],
      revivedToken: false,
    });
    expect(
      fs
        .readFileSync(
          path.join(root, "auth", ".credential-storage-generation"),
          "utf8",
        )
        .trim(),
    ).toBe("1");
    expect(fs.existsSync(path.join(root, "callback-count"))).toBe(false);
  } finally {
    await stopOwnershipProbe(reset);
    if (recovery) await stopOwnershipProbe(recovery);
  }
});

it("admits a waiting process after owner fsync failure while the failed owner remains alive", async () => {
  const root = path.join(container, "waiting-publication");
  fs.mkdirSync(root);
  const failed = startOwnershipProbe(root, "fail-owner");
  let holder: OwnershipProbe | undefined;
  try {
    await waitForOwnershipBarrier(failed, "fail-owner-ready");
    holder = startOwnershipProbe(root, "waiting-holder");
    await waitForOwnershipBarrier(holder, "holder-waiting");
    fs.writeFileSync(path.join(root, "fail-owner-go"), "go");
    await waitForOwnershipBarrier(failed, "fail-owner-result.json");
    expect(
      JSON.parse(
        fs.readFileSync(path.join(root, "fail-owner-result.json"), "utf8"),
      ),
    ).toMatchObject({ ok: false, code: "EIO" });
    await waitForOwnershipBarrier(holder, "waiting-holder-ready");
    expect(failed.child.exitCode).toBeNull();
    fs.writeFileSync(path.join(root, "waiting-holder-go"), "go");
    expect(await finishOwnershipProbe(holder)).toEqual({ ok: true });
    fs.writeFileSync(path.join(root, "failed-process-go"), "go");
    expect(await finishOwnershipProbe(failed)).toMatchObject({
      ok: false,
      code: "EIO",
    });
  } finally {
    await stopOwnershipProbe(failed);
    if (holder) await stopOwnershipProbe(holder);
  }
});

for (const failure of ["unlink", "fsync"] as const) {
  it.skipIf(process.platform === "win32" && failure === "fsync")(
    `keeps an unconfirmed reset fenced after intent ${failure} failure`,
    () => {
      const root = path.join(container, `intent-${failure}`);
      const policy = createIsolatedAccountStoragePolicy(root);
      saveAccount(
        {
          id: "before",
          providerId: "openai-codex",
          label: "Before",
          source: "oauth",
          credentials: {
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: 9_999_999_999_999,
          },
          createdAt: 1,
          updatedAt: 1,
        },
        policy,
      );
      const intent = path.join(policy.authRoot, ".credential-storage-reset");
      const generation = path.join(
        policy.authRoot,
        ".credential-storage-generation",
      );
      const originalUnlink = fs.unlinkSync;
      const originalFsync = fs.fsyncSync;
      let injected = false;
      let calls = 0;
      try {
        fs.unlinkSync = (file) => {
          if (failure === "unlink" && !injected && String(file) === intent) {
            injected = true;
            throw Object.assign(new Error("injected intent unlink failure"), {
              code: "EIO",
            });
          }
          originalUnlink(file);
        };
        fs.fsyncSync = (descriptor) => {
          if (
            failure === "fsync" &&
            !injected &&
            fs.existsSync(generation) &&
            !fs.existsSync(intent)
          ) {
            injected = true;
            throw Object.assign(new Error("injected intent fsync failure"), {
              code: "EIO",
            });
          }
          originalFsync(descriptor);
        };
        expect(() =>
          resetAccountCredentialStorage(policy, () => {
            calls++;
          }),
        ).toThrow(
          "Credential reset advanced its generation but did not confirm completion",
        );
      } finally {
        fs.unlinkSync = originalUnlink;
        fs.fsyncSync = originalFsync;
      }
      expect(injected).toBe(true);
      const restarted = createIsolatedAccountStoragePolicy(root);
      expect(loadAccount("openai-codex", "before", restarted)).toBeNull();
      expect(calls).toBe(1);
      expect(() => loadAccount("openai-codex", "before", policy)).toThrow(
        "Credential storage policy predates the latest reset",
      );
    },
  );
}

it("checks the acquisition deadline after a raced-away lock directory", () => {
  const policy = createIsolatedAccountStoragePolicy(
    path.join(container, "deadline"),
  );
  const lock = path.join(policy.authRoot, ".credential-storage.lock");
  const originalMkdir = fs.mkdirSync;
  const originalNow = performance.now;
  let ticks = 0;
  let attempts = 0;
  try {
    performance.now = () => {
      ticks += 20_000;
      return ticks;
    };
    fs.mkdirSync = ((directory, options) => {
      if (String(directory) === lock) {
        attempts++;
        if (attempts > 2) throw new Error("lock retry bypassed its deadline");
        originalMkdir(directory, options);
        fs.rmdirSync(directory);
        throw Object.assign(new Error("raced acquisition"), { code: "EEXIST" });
      }
      return originalMkdir(directory, options);
    }) as typeof fs.mkdirSync;
    expect(() =>
      saveAccount(
        {
          id: "deadline",
          providerId: "openai-codex",
          label: "Deadline",
          source: "oauth",
          credentials: {
            access: "fixture-access",
            refresh: "fixture-refresh",
            expires: 9_999_999_999_999,
          },
          createdAt: 1,
          updatedAt: 1,
        },
        policy,
      ),
    ).toThrow("Timed out waiting for the credential storage lock");
  } finally {
    fs.mkdirSync = originalMkdir;
    performance.now = originalNow;
  }
  expect(attempts).toBe(1);
});

it("rejects generation exhaustion before deleting any credential or invoking the host", () => {
  const root = path.join(container, "generation-exhaustion");
  const initial = createIsolatedAccountStoragePolicy(root);
  const record = saveAccount(
    {
      id: "preserved",
      providerId: "openai-codex",
      label: "Preserved",
      source: "oauth",
      credentials: {
        access: "fixture-access",
        refresh: "fixture-refresh",
        expires: 9_999_999_999_999,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    initial,
  );
  const file = path.join(initial.authRoot, "openai-codex", "preserved.json");
  const before = fs.readFileSync(file);
  fs.writeFileSync(
    path.join(initial.authRoot, ".credential-storage-generation"),
    `${Number.MAX_SAFE_INTEGER}\n`,
  );
  const policy = createIsolatedAccountStoragePolicy(root);
  let calls = 0;
  expect(() =>
    resetAccountCredentialStorage(policy, () => {
      calls++;
    }),
  ).toThrow(
    "Credential storage generation cannot advance beyond the supported range",
  );
  expect(calls).toBe(0);
  expect(fs.readFileSync(file)).toEqual(before);
  expect(loadAccount("openai-codex", "preserved", policy)).toEqual(record);
  expect(
    fs.existsSync(path.join(policy.authRoot, ".credential-storage-reset")),
  ).toBe(false);
});
