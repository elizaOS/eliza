#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import path from "node:path";
import { readElizaSourceLock } from "./read-eliza-source-lock.mjs";

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (!name?.startsWith("--") || value === undefined) {
    throw new Error("arguments must be --name value pairs");
  }
  values.set(name.slice(2), value);
}

const lockPath = path.resolve(
  values.get("lock") ?? "release/eliza-source.lock.json",
);
const commit = values.get("commit");
const commitTimestamp = values.get("commit-timestamp");
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  throw new Error("--commit must be a full lowercase Git SHA");
}
if (
  !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(commitTimestamp ?? "") ||
  Number.isNaN(Date.parse(commitTimestamp))
) {
  throw new Error("--commit-timestamp must be an RFC 3339 UTC timestamp");
}

const current = readElizaSourceLock(lockPath);
const updated = { ...current, commit, commitTimestamp };
writeFileSync(lockPath, `${JSON.stringify(updated, null, 2)}\n`);
readElizaSourceLock(lockPath);
