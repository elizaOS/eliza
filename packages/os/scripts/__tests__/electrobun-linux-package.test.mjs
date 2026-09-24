import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const verifier = path.join(
  repoRoot,
  "scripts/verify-electrobun-linux-package.sh",
);

async function fixture() {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "elizaos-electrobun-test-"),
  );
  const source = path.join(root, "source");
  await execFileAsync("mkdir", [source]);
  const installer = path.join(source, "installer");
  await writeFile(
    installer,
    "ELF fixture ELECTROBUN_METADATA_V1 {} ELECTROBUN_ARCHIVE_V1 payload\n",
  );
  await chmod(installer, 0o755);
  await writeFile(path.join(source, "README.txt"), "Install elizaOS\n");
  return { root, source };
}

async function archive(source, output) {
  await execFileAsync("tar", ["-czf", output, "-C", source, "."], {
    env: { ...process.env, COPYFILE_DISABLE: "1" },
  });
}

test("Electrobun Linux package verifier accepts the exact installer envelope", async () => {
  const { root, source } = await fixture();
  const payload = path.join(root, "package.tar.gz");
  await archive(source, payload);
  const { stdout } = await execFileAsync(verifier, [payload], {
    cwd: repoRoot,
  });
  assert.match(stdout, /Verified Electrobun Linux package/);
});

test("Electrobun Linux package verifier rejects links and unexpected members", async () => {
  const { root, source } = await fixture();
  await symlink("README.txt", path.join(source, "extra"));
  const payload = path.join(root, "poisoned.tar.gz");
  await archive(source, payload);
  await assert.rejects(
    execFileAsync(verifier, [payload], { cwd: repoRoot }),
    /unexpected archive member/,
  );
});
