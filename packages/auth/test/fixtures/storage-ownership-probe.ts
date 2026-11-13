/** Real process boundaries for the credential lock/reset Quint conformance. */
import fs from "node:fs";
import path from "node:path";
import {
  createRuntimeAccountStoragePolicy,
  listAccounts,
  resetAccountCredentialStorage,
  saveAccount,
  withAccountStorageMutation,
} from "../../src/auth/account-storage.ts";
import { getAccessToken } from "../../src/auth/credentials.ts";

const root = process.env.STORAGE_PROBE_ROOT;
const mode = process.env.STORAGE_PROBE_MODE;
if (!root || !mode) throw new Error("Missing storage probe configuration");
const barrier = (name: string) => path.join(root, name);
function signal(name: string): void {
  fs.writeFileSync(barrier(name), "ready");
}
function wait(name: string): void {
  const deadline = performance.now() + 40_000;
  while (!fs.existsSync(barrier(name))) {
    if (performance.now() > deadline)
      throw new Error(`Missing barrier ${name}`);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
const lockDir = path.join(
  fs.realpathSync(root),
  "auth",
  ".credential-storage.lock",
);
const originalRename = fs.renameSync;
let pausedRename = false;
if (mode === "reaper") {
  fs.renameSync = (from, to) => {
    if (!pausedRename && String(from) === lockDir) {
      pausedRename = true;
      signal("reaper-observed");
      wait("reaper-rename");
    }
    originalRename(from, to);
    if (String(from) === lockDir) signal("reaper-renamed");
  };
}
const originalUnlink = fs.unlinkSync;
if (mode === "holder") {
  fs.unlinkSync = (file) => {
    originalUnlink(file);
    if (
      fs.existsSync(barrier("holder-go")) &&
      String(file).startsWith(`${lockDir}.stale.`) &&
      String(file).endsWith("/owner.json")
    ) {
      signal("holder-release-unlinked");
      wait("holder-release-go");
    }
  };
}
if (mode === "reset-first-file" || mode === "recover-first-file") {
  let paused = false;
  fs.unlinkSync = (file) => {
    originalUnlink(file);
    if (
      !paused &&
      String(file).endsWith(
        mode === "reset-first-file" ? "original-a.json" : "original-b.json",
      )
    ) {
      paused = true;
      signal(mode === "recover-first-file" ? "recovery-ready" : "reset-ready");
      wait("reset-go");
    }
  };
}
if (mode === "reset-generation") {
  fs.renameSync = (from, to) => {
    originalRename(from, to);
    if (String(to).endsWith(".credential-storage-generation")) {
      signal("reset-ready");
      wait("reset-go");
    }
  };
}
const originalOpen = fs.openSync;
const originalFsync = fs.fsyncSync;
const originalMkdir = fs.mkdirSync;
if (mode === "waiting-holder") {
  fs.mkdirSync = ((directory, options) => {
    try {
      return originalMkdir(directory, options);
    } catch (cause) {
      if (
        String(directory) === lockDir &&
        (cause as NodeJS.ErrnoException).code === "EEXIST"
      ) {
        signal("holder-waiting");
      }
      throw cause;
    }
  }) as typeof fs.mkdirSync;
}

if (mode === "fail-owner") {
  const ownerDescriptors = new Set<number>();
  let failed = false;
  fs.openSync = ((file, flags, mode) => {
    const descriptor = originalOpen(file, flags, mode);
    if (String(file) === path.join(lockDir, "owner.json"))
      ownerDescriptors.add(descriptor);
    return descriptor;
  }) as typeof fs.openSync;
  fs.fsyncSync = (descriptor) => {
    if (!failed && ownerDescriptors.has(descriptor)) {
      failed = true;
      signal("fail-owner-ready");
      wait("fail-owner-go");
      throw Object.assign(new Error("injected owner publication failure"), {
        code: "EIO",
      });
    }
    originalFsync(descriptor);
  };
}
const record = (id: string) => ({
  id,
  providerId: "openai-codex" as const,
  label: id,
  source: "oauth" as const,
  credentials: {
    access: "fixture-access",
    refresh: "fixture-refresh",
    expires: 9_999_999_999_999,
  },
  createdAt: 1,
  updatedAt: 1,
});
let result: Record<string, unknown>;
try {
  const policy = createRuntimeAccountStoragePolicy(root);
  if (mode === "seed") {
    saveAccount(record("original-a"), policy);
    saveAccount(record("original-b"), policy);
    result = { ok: true };
  } else if (mode === "read") {
    const accounts = listAccounts("openai-codex", policy);
    const token = await getAccessToken("openai-codex", "stale-writer", {
      storagePolicy: policy,
      outcome: true,
    });
    result = {
      ok: true,
      ids: accounts.map((account) => account.id).sort(),
      revivedToken: token.ok,
    };
  } else if (mode === "fail-owner") {
    saveAccount(record(mode), policy);
    result = { ok: true };
  } else if (mode === "recover-first-file") {
    result = { ok: true };
  } else if (mode === "writer") {
    signal("writer-ready");
    wait("writer-go");
    saveAccount(record("stale-writer"), policy);
    result = { ok: true };
  } else if (mode.startsWith("reset-")) {
    resetAccountCredentialStorage(policy, () => {
      fs.appendFileSync(barrier("callback-count"), "1");
      if (mode === "reset-callback") {
        signal("reset-ready");
        wait("reset-go");
      }
    });
    result = { ok: true };
  } else {
    withAccountStorageMutation(policy, "probe-held-mutation", (scope) => {
      signal(`${mode}-ready`);
      wait(`${mode}-go`);
      scope.saveAccount(record(mode));
    });
    result = { ok: true };
  }
} catch (error) {
  result = {
    ok: false,
    code: (error as { code?: string }).code ?? (error as Error).name,
    message: (error as Error).message,
  };
} finally {
  fs.renameSync = originalRename;
  fs.unlinkSync = originalUnlink;
  fs.openSync = originalOpen;
  fs.fsyncSync = originalFsync;
  fs.mkdirSync = originalMkdir;
}
fs.writeFileSync(barrier(`${mode}-result.json`), JSON.stringify(result));

if (mode === "fail-owner") wait("failed-process-go");
