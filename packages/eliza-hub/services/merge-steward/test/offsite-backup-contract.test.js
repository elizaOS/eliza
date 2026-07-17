import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFile,
  chmod,
  copyFile,
  cp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { promisify } from "node:util";
import { mkdtempInTestRoot } from "./helpers/tmp-root.js";

const execFileAsync = promisify(execFile);
const BACKUP_OFFSITE_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/backup-offsite.sh",
  import.meta.url,
);
const RESTORE_OFFSITE_CHECK_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/restore-offsite-check.sh",
  import.meta.url,
);
const BACKUP_EVIDENCE_PATH = new URL(
  "../../../deployment/hetzner-staging/scripts/backup-evidence.mjs",
  import.meta.url,
);
const AGE_TOOLS_AVAILABLE = ["age", "age-keygen"].every(
  (command) =>
    spawnSync(command, ["--version"], { stdio: "ignore" }).status === 0,
);
const describeWithAge = AGE_TOOLS_AVAILABLE ? describe : describe.skip;

describeWithAge("encrypted off-site backup contract", () => {
  it("encrypts, uploads, download-verifies, and recovers a backup without plaintext remote data", async () => {
    const fixture = await createFixture();

    try {
      const upload = await runUpload(fixture, ["--apply"]);
      assert.match(upload.stdout, /encrypted off-host backup verified/);

      const receipt = JSON.parse(await readFile(fixture.uploadReceipt, "utf8"));
      assert.equal(receipt.status, "verified");
      assert.equal(receipt.encryption.format, "age");
      assert.match(receipt.encryption.recipientsFileSha256, /^[a-f0-9]{64}$/u);
      assert.equal(receipt.uploadVerified, true);
      assert.equal(receipt.verificationMethod, "download_sha256");
      assert.match(receipt.ciphertext.sha256, /^[a-f0-9]{64}$/u);
      assert.ok(receipt.ciphertext.bytes > 0);

      const remoteCiphertext = remotePath(
        fixture.remoteRoot,
        receipt.remoteArchive,
      );
      const remoteReceipt = remotePath(
        fixture.remoteRoot,
        receipt.remoteReceipt,
      );
      assert.equal(
        (await stat(remoteCiphertext)).size,
        receipt.ciphertext.bytes,
      );
      assert.equal(
        sha256(await readFile(remoteCiphertext)),
        receipt.ciphertext.sha256,
      );
      assert.deepEqual(
        JSON.parse(await readFile(remoteReceipt, "utf8")),
        receipt,
      );

      const restore = await runRestore(fixture, receipt.remoteReceipt);
      assert.match(restore.stdout, /off-host recovery check passed/);

      const restoreReceipt = JSON.parse(
        await readFile(fixture.restoreReceipt, "utf8"),
      );
      assert.equal(restoreReceipt.status, "verified");
      assert.equal(restoreReceipt.downloadVerified, true);
      assert.equal(restoreReceipt.decryptionVerified, true);
      assert.equal(restoreReceipt.archivePathsVerified, true);
      assert.equal(restoreReceipt.structuralRestoreCheckPassed, true);
      assert.equal(restoreReceipt.ciphertext.sha256, receipt.ciphertext.sha256);

      const evidence = await runBackupEvidence(fixture);
      assert.equal(evidence.backups.offHost, true);
      assert.equal(evidence.backups.encrypted, true);
      assert.equal(evidence.backups.backupEvidence.status, "verified");
      assert.equal(evidence.backups.backupEvidence.productionReady, true);
      assert.equal(evidence.backups.backupEvidence.checkCount, 10);
      assert.equal(
        evidence.backups.backupEvidence.offsiteUploadReceipt
          .recipientsFileSha256,
        receipt.encryption.recipientsFileSha256,
      );
      assert.equal(
        evidence.backups.backupEvidence.offsiteUploadReceipt.sha256,
        sha256(await readFile(fixture.uploadReceipt)),
      );
      assert.equal(
        evidence.backups.backupEvidence.offsiteRestoreReceipt.sha256,
        sha256(await readFile(fixture.restoreReceipt)),
      );

      const remoteFiles = await listFiles(fixture.remoteRoot);
      assert.deepEqual(
        remoteFiles.sort(),
        [
          `bucket/staging/${fixture.backupName}/receipt.json`,
          `bucket/staging/${fixture.backupName}/${fixture.backupName}.tar.gz.age`,
        ].sort(),
      );
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("is non-mutating by default", async () => {
    const fixture = await createFixture();

    try {
      const result = await runUpload(fixture);
      assert.match(result.stdout, /no remote writes performed/);
      assert.match(result.stdout, /"dryRun": true/);
      assert.deepEqual(await listFiles(fixture.remoteRoot), []);
      await assert.rejects(stat(fixture.uploadReceipt), { code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a remote ciphertext changed after upload", async () => {
    const fixture = await createFixture();

    try {
      await runUpload(fixture, ["--apply"]);
      const receipt = JSON.parse(await readFile(fixture.uploadReceipt, "utf8"));
      await appendFile(
        remotePath(fixture.remoteRoot, receipt.remoteArchive),
        "tampered",
      );

      let failure;
      try {
        await runRestore(fixture, receipt.remoteReceipt);
      } catch (error) {
        failure = error;
      }

      assert.ok(failure, "restore check should reject changed ciphertext");
      assert.match(failure.stderr, /downloaded ciphertext SHA-256 mismatch/);
      await assert.rejects(stat(fixture.restoreReceipt), { code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects links in a correctly encrypted remote archive before extraction", async () => {
    const fixture = await createFixture();

    try {
      await runUpload(fixture, ["--apply"]);
      const receipt = JSON.parse(await readFile(fixture.uploadReceipt, "utf8"));
      const maliciousParent = path.join(fixture.root, "malicious");
      const maliciousBackup = path.join(maliciousParent, fixture.backupName);
      const plaintextArchive = path.join(fixture.root, "malicious.tar.gz");
      const ciphertext = path.join(fixture.root, "malicious.tar.gz.age");
      await cp(fixture.backupDir, maliciousBackup, { recursive: true });
      await symlink(
        "/etc/passwd",
        path.join(maliciousBackup, "host", "unsafe-link"),
      );
      await execFileAsync("tar", [
        "-czf",
        plaintextArchive,
        "-C",
        maliciousParent,
        fixture.backupName,
      ]);
      await execFileAsync("age", [
        "-R",
        fixture.recipientsFile,
        "-o",
        ciphertext,
        plaintextArchive,
      ]);

      receipt.ciphertext.sha256 = sha256(await readFile(ciphertext));
      receipt.ciphertext.bytes = (await stat(ciphertext)).size;
      await copyFile(
        ciphertext,
        remotePath(fixture.remoteRoot, receipt.remoteArchive),
      );
      await writeFile(
        remotePath(fixture.remoteRoot, receipt.remoteReceipt),
        `${JSON.stringify(receipt, null, 2)}\n`,
      );
      await writeFile(
        fixture.uploadReceipt,
        `${JSON.stringify(receipt, null, 2)}\n`,
      );

      let failure;
      try {
        await runRestore(fixture, receipt.remoteReceipt);
      } catch (error) {
        failure = error;
      }

      assert.ok(failure, "restore check should reject link entries");
      assert.match(failure.stderr, /link or special file/);
      await assert.rejects(stat(fixture.restoreReceipt), { code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects a remote receipt that does not match the separately supplied digest", async () => {
    const fixture = await createFixture();

    try {
      await runUpload(fixture, ["--apply"]);
      const receipt = JSON.parse(await readFile(fixture.uploadReceipt, "utf8"));
      const remoteReceipt = remotePath(
        fixture.remoteRoot,
        receipt.remoteReceipt,
      );
      await appendFile(remoteReceipt, "\n");

      let failure;
      try {
        await runRestore(fixture, receipt.remoteReceipt);
      } catch (error) {
        failure = error;
      }

      assert.ok(
        failure,
        "restore check should reject an untrusted remote receipt",
      );
      assert.match(failure.stderr, /independently supplied digest/);
      await assert.rejects(stat(fixture.restoreReceipt), { code: "ENOENT" });
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});

async function createFixture() {
  const root = await mkdtempInTestRoot("offsite-backup-");
  const backupName = "eliza-forgejo-staging-20260712T020000Z";
  const backupDir = path.join(root, "backups", backupName);
  const remoteRoot = path.join(root, "remote");
  const binDir = path.join(root, "bin");
  const keyDir = path.join(root, "keys");
  const artifactRoot = path.join(root, "artifacts");
  const cacheRoot = path.join(root, "cache");
  const identityFile = path.join(keyDir, "backup-identity.txt");
  const recipientsFile = path.join(keyDir, "backup-recipients.txt");
  const uploadReceipt = path.join(artifactRoot, "upload-receipt.json");
  const restoreReceipt = path.join(artifactRoot, "restore-receipt.json");

  await mkdir(path.join(backupDir, "archives"), { recursive: true });
  await mkdir(path.join(backupDir, "host"), { recursive: true });
  await mkdir(path.join(backupDir, "postgres"), { recursive: true });
  await mkdir(remoteRoot, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await mkdir(keyDir, { recursive: true });

  await writeFile(path.join(backupDir, "env.keys"), "FORGEJO_DOMAIN\n");
  await writeFile(
    path.join(backupDir, "host", "compose.yml"),
    "services: {}\n",
  );
  await writeFile(
    path.join(backupDir, "host", ".env.example"),
    "FORGEJO_DOMAIN=example.invalid\n",
  );
  await writeFile(
    path.join(backupDir, "postgres", "pg_dumpall.sql"),
    "-- PostgreSQL database cluster dump\nCREATE ROLE forgejo;\n",
  );

  const payloadDir = path.join(root, "archive-payload");
  const archiveSource = path.join(root, "archive.tar.gz");
  await mkdir(payloadDir, { recursive: true });
  await writeFile(
    path.join(payloadDir, "payload.txt"),
    "verified backup payload\n",
  );
  await execFileAsync("tar", ["-czf", archiveSource, "-C", payloadDir, "."]);

  for (const name of [
    "forgejo-data.tar.gz",
    "forgejo-config.tar.gz",
    "eliza-custom.tar.gz",
    "eliza-templates.tar.gz",
  ]) {
    await copyFile(archiveSource, path.join(backupDir, "archives", name));
  }

  await writeFile(
    path.join(backupDir, "MANIFEST.txt"),
    [
      `name=${backupName}`,
      "created_utc=20260712T020000Z",
      "secrets_included=false",
      "restore_target=empty-staging-host-only",
      "",
    ].join("\n"),
  );
  await writeChecksums(backupDir);

  await execFileAsync("age-keygen", ["-o", identityFile]);
  await chmod(identityFile, 0o600);
  const { stdout: recipient } = await execFileAsync("age-keygen", [
    "-y",
    identityFile,
  ]);
  await writeFile(recipientsFile, recipient, { mode: 0o644 });
  await writeExecutable(path.join(binDir, "rclone"), fakeRclone());

  return {
    root,
    backupName,
    backupDir,
    remoteRoot,
    binDir,
    cacheRoot,
    artifactRoot,
    identityFile,
    recipientsFile,
    uploadReceipt,
    restoreReceipt,
  };
}

async function runUpload(fixture, args = []) {
  return execFileAsync(
    "bash",
    [BACKUP_OFFSITE_PATH.pathname, "--backup-dir", fixture.backupDir, ...args],
    {
      env: commonEnv(fixture, {
        BACKUP_OFFSITE_REMOTE: "fake:bucket/staging",
        BACKUP_AGE_RECIPIENTS_FILE: fixture.recipientsFile,
        BACKUP_OFFSITE_RECEIPT_OUTPUT: fixture.uploadReceipt,
      }),
    },
  );
}

async function runRestore(fixture, remoteReceipt) {
  const expectedReceiptSha256 = sha256(await readFile(fixture.uploadReceipt));
  return execFileAsync(
    "bash",
    [
      RESTORE_OFFSITE_CHECK_PATH.pathname,
      "--receipt-remote",
      remoteReceipt,
      "--expected-receipt-sha256",
      expectedReceiptSha256,
      "--apply",
    ],
    {
      env: commonEnv(fixture, {
        BACKUP_OFFSITE_ALLOWED_REMOTE: "fake:bucket/staging",
        BACKUP_AGE_IDENTITY_FILE: fixture.identityFile,
        BACKUP_OFFSITE_RESTORE_RECEIPT_OUTPUT: fixture.restoreReceipt,
      }),
    },
  );
}

async function runBackupEvidence(fixture) {
  const auditOutput = path.join(fixture.artifactRoot, "backup-audit.json");
  const { stdout } = await execFileAsync(
    "node",
    [
      BACKUP_EVIDENCE_PATH.pathname,
      "--backup-dir",
      fixture.backupDir,
      "--offsite-upload-receipt",
      fixture.uploadReceipt,
      "--offsite-restore-receipt",
      fixture.restoreReceipt,
      "--audit-output",
      auditOutput,
    ],
    {
      env: commonEnv(fixture, {
        BACKUP_EVIDENCE_SCHEDULED: "true",
        BACKUP_EVIDENCE_NOW: "2026-07-12T03:00:00Z",
      }),
    },
  );

  return JSON.parse(stdout);
}

function commonEnv(fixture, overrides) {
  return {
    ...process.env,
    ...overrides,
    PATH: `${fixture.binDir}:${process.env.PATH}`,
    ALLOW_ENV_ONLY: "true",
    ENV_FILE: path.join(fixture.root, "missing.env"),
    ELIZA_ARTIFACT_ROOT: fixture.artifactRoot,
    ELIZA_CACHE_ROOT: fixture.cacheRoot,
    FAKE_RCLONE_ROOT: fixture.remoteRoot,
  };
}

async function writeChecksums(backupDir) {
  const files = (await listFiles(backupDir)).filter(
    (file) => file !== "SHA256SUMS",
  );
  const lines = [];

  for (const relativePath of files.sort()) {
    lines.push(
      `${sha256(await readFile(path.join(backupDir, relativePath)))}  ${relativePath}`,
    );
  }

  await writeFile(path.join(backupDir, "SHA256SUMS"), `${lines.join("\n")}\n`);
}

async function listFiles(root, relative = "") {
  const target = path.join(root, relative);
  const entries = await readdir(target, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryRelative = path.posix.join(
      relative.replaceAll(path.sep, "/"),
      entry.name,
    );
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, entryRelative)));
    } else if (entry.isFile()) {
      files.push(entryRelative);
    }
  }

  return files;
}

function remotePath(root, value) {
  const separator = value.indexOf(":");
  assert.notEqual(separator, -1, `expected an rclone path, received ${value}`);
  return path.join(root, value.slice(separator + 1).replace(/^\/+/, ""));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeExecutable(filePath, body) {
  await writeFile(filePath, body, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

function fakeRclone() {
  return `#!/usr/bin/env bash
set -euo pipefail

map_remote() {
  local value="$1"
  local relative="\${value#*:}"
  printf '%s/%s\n' "$FAKE_RCLONE_ROOT" "\${relative#/}"
}

case "\${1:-}" in
  copyto)
    source_path="$2"
    destination_path="$3"
    if [[ "$source_path" == *:* ]]; then
      source_path="$(map_remote "$source_path")"
    fi
    if [[ "$destination_path" == *:* ]]; then
      destination_path="$(map_remote "$destination_path")"
      if [[ " $* " == *" --immutable "* && -e "$destination_path" ]]; then
        printf 'immutable destination already exists\n' >&2
        exit 9
      fi
    fi
    mkdir -p "$(dirname "$destination_path")"
    cp "$source_path" "$destination_path"
    ;;
  cat)
    cat "$(map_remote "$2")"
    ;;
  *)
    printf 'unsupported fake rclone command: %s\n' "\${1:-}" >&2
    exit 2
    ;;
esac
`;
}
