/** Executes real account-storage operations in child runtimes for isolation tests. */

import fs from "node:fs";
import path from "node:path";
import {
  createIsolatedAccountStoragePolicy,
  deleteAccount,
  loadAccount,
  saveAccount,
  touchAccount,
} from "./account-storage.ts";

const stateRoot = process.env.ELIZA_STORAGE_PROBE_ROOT;
const resultFile = process.env.ELIZA_STORAGE_PROBE_RESULT;
if (!stateRoot || !resultFile) {
  throw new Error("probe root and result path are required");
}

let result: Record<string, unknown>;
try {
  const policy = createIsolatedAccountStoragePolicy(stateRoot);
  if (process.env.ELIZA_STORAGE_PROBE_MODE === "reset-race") {
    const readyFile = process.env.ELIZA_STORAGE_PROBE_READY;
    const goFile = process.env.ELIZA_STORAGE_PROBE_GO;
    if (!readyFile || !goFile) {
      throw new Error("reset race probe requires ready and go paths");
    }
    fs.writeFileSync(readyFile, "ready");
    process.stdout.write("ready\n");
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(goFile) && Date.now() < deadline) {
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)),
        0,
        0,
        10,
      );
    }
    if (!fs.existsSync(goFile)) throw new Error("reset race probe timed out");
  }
  saveAccount(
    {
      id: "child-account",
      providerId: "openai-codex",
      label: "Child account",
      source: "oauth",
      credentials: {
        access: "access",
        refresh: "refresh",
        expires: Date.now() + 60_000,
      },
      createdAt: 1,
      updatedAt: 1,
    },
    policy,
  );
  if (process.env.ELIZA_STORAGE_PROBE_MODE === "reset-race") {
    result = { ok: true };
  } else {
    touchAccount("openai-codex", "child-account", policy);
    const loaded = loadAccount("openai-codex", "child-account", policy);
    deleteAccount("openai-codex", "child-account", policy);
    result = {
      ok: loaded?.id === "child-account",
      owner: policy.owner,
      remaining: fs.existsSync(
        path.join(stateRoot, "auth", "openai-codex", "child-account.json"),
      ),
    };
  }
} catch (error) {
  result = {
    ok: false,
    code:
      typeof error === "object" && error !== null && "code" in error
        ? String(error.code)
        : "UNKNOWN",
  };
}
fs.writeFileSync(resultFile, JSON.stringify(result));
