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
