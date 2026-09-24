import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sha256File } from "../os-release-lib.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifier = path.join(repoRoot, "scripts/verify-release.sh");

test("download verifier requires every checksummed payload", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elizaos-verify-"));
  await writeFile(
    path.join(directory, "SHA256SUMS"),
    `${"a".repeat(64)}  missing.iso\n`,
  );
  await assert.rejects(
    execFileAsync(verifier, [directory], { env: { PATH: "/usr/bin:/bin" } }),
    /required checksum payload is missing/,
  );
});

test("download verifier accepts a complete checksum roundtrip", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elizaos-verify-"));
  const payload = path.join(directory, "payload.iso");
  await writeFile(payload, "verified payload\n");
  await writeFile(
    path.join(directory, "SHA256SUMS"),
    `${await sha256File(payload)}  payload.iso\n`,
  );
  const result = await execFileAsync(verifier, [directory], {
    env: {
      PATH: "/usr/bin:/bin",
      ELIZAOS_VERIFY_ATTESTATIONS: "skip",
    },
  });
  assert.match(result.stdout, /SHA256SUMS roundtrip verified \(1 entries\)/);
});

test("download verifier rejects duplicate checksum entries", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "elizaos-verify-"));
  const payload = path.join(directory, "payload.iso");
  await writeFile(payload, "verified payload\n");
  const entry = `${await sha256File(payload)}  payload.iso\n`;
  await writeFile(path.join(directory, "SHA256SUMS"), `${entry}${entry}`);

  await assert.rejects(
    execFileAsync(verifier, [directory], { env: { PATH: "/usr/bin:/bin" } }),
    /duplicate SHA256SUMS entry/,
  );
});
