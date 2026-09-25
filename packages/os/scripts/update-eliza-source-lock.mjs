#!/usr/bin/env node
import {
  chmodSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  defaultElizaSourceLockPath,
  readElizaSourceLock,
  validateElizaSourceLock,
} from "./read-eliza-source-lock.mjs";

export function parseSourceLockUpdateArguments(argv) {
  const values = new Map();
  const allowed = new Set(["--lock", "--commit", "--commit-timestamp"]);
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (
      !allowed.has(name) ||
      values.has(name) ||
      value === undefined ||
      value.startsWith("--")
    ) {
      throw new Error(
        `Unknown, duplicate, or incomplete source-lock option: ${name}`,
      );
    }
    values.set(name, value);
  }
  return {
    lockPath: values.has("--lock")
      ? path.resolve(values.get("--lock"))
      : defaultElizaSourceLockPath,
    commit: values.get("--commit"),
    commitTimestamp: values.get("--commit-timestamp"),
  };
}

export function updateElizaSourceLock({ lockPath, commit, commitTimestamp }) {
  const current = readElizaSourceLock(lockPath);
  const updated = validateElizaSourceLock({
    ...current,
    commit,
    commitTimestamp,
  });
  const mode = statSync(lockPath).mode & 0o777;
  const directory = mkdtempSync(
    path.join(path.dirname(lockPath), ".eliza-source-lock-"),
  );
  const temporary = path.join(directory, "lock.json");
  try {
    writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
      flag: "wx",
      mode,
    });
    chmodSync(temporary, mode);
    renameSync(temporary, lockPath);
  } finally {
    rmSync(directory, { recursive: true });
  }
  return updated;
}

if (import.meta.main) {
  updateElizaSourceLock(parseSourceLockUpdateArguments(process.argv.slice(2)));
}
