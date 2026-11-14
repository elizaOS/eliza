import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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

async function fixture(t) {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "elizaos-electrobun-test-"),
  );
  t.after(() => rm(root, { recursive: true, force: true }));
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

test("Electrobun Linux package verifier accepts the exact installer envelope", async (t) => {
  const { root, source } = await fixture(t);
  const payload = path.join(root, "package.tar.gz");
  await archive(source, payload);
  const { stdout } = await execFileAsync(verifier, [payload], {
    cwd: repoRoot,
  });
  assert.match(stdout, /Verified Electrobun Linux package/);
});

test("Electrobun Linux package verifier rejects links and unexpected members", async (t) => {
  const { root, source } = await fixture(t);
  await symlink("README.txt", path.join(source, "extra"));
  const payload = path.join(root, "poisoned.tar.gz");
  await archive(source, payload);
  await assert.rejects(
    execFileAsync(verifier, [payload], { cwd: repoRoot }),
    /unexpected archive member/,
  );
});

async function packagedFixture(t, kind) {
  const { root, source } = await fixture(t);
  await execFileAsync("python3", [
    "-c",
    `
import io, pathlib, subprocess, sys, tarfile
root, kind = pathlib.Path(sys.argv[1]), sys.argv[2]
data = io.BytesIO()
with tarfile.open(fileobj=data, mode="w") as archive:
    for _ in range(2 if kind == "duplicate" else 1):
        entry = tarfile.TarInfo("elizaOSUSBInstaller/Resources/app/native/linux-raw-writer" if kind != "missing" else "other")
        entry.mode = 0o644 if kind == "not-executable" else 0o755
        content = b"bad" if kind == "not-elf" else b"\\x7fELFfixture"
        if kind == "link":
            entry.type = tarfile.SYMTYPE
            entry.linkname = "/etc/passwd"
        else:
            entry.size = len(content)
        archive.addfile(entry, io.BytesIO(content))
compressed = subprocess.run(["zstd", "-q", "-c"], input=data.getvalue(), capture_output=True, check=True).stdout
if kind == "corrupt":
    compressed = compressed[:-4]
(root / "source/installer").write_bytes(b"ELECTROBUN_METADATA_V1{}ELECTROBUN_ARCHIVE_V1" + compressed)
`,
    root,
    kind,
  ]);
  const payload = path.join(root, "package.tar.gz");
  await archive(source, payload);
  return { payload, output: path.join(root, "writer") };
}

test("extracts exact packaged writer bytes and refuses to replace an existing output", async (t) => {
  const { payload, output } = await packagedFixture(t, "valid");
  await execFileAsync(verifier, [payload, output]);
  assert.deepEqual(await readFile(output), Buffer.from("\x7fELFfixture"));
  await writeFile(output, "preserve existing output");
  await assert.rejects(
    execFileAsync(verifier, [payload, output]),
    /FileExistsError/,
  );
  assert.equal(await readFile(output, "utf8"), "preserve existing output");
});

for (const kind of [
  "missing",
  "duplicate",
  "link",
  "not-executable",
  "not-elf",
  "corrupt",
]) {
  test(`packaged writer extraction rejects ${kind} payloads without creating output`, async (t) => {
    const { payload, output } = await packagedFixture(t, kind);
    await assert.rejects(execFileAsync(verifier, [payload, output]));
    await assert.rejects(readFile(output), { code: "ENOENT" });
  });
}
