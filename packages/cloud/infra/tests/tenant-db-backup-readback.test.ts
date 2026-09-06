/**
 * Runs the actual backup publication and retention shell with real file hashes.
 * The object-store transport is a filesystem fixture; corrupted bytes and failed
 * reads must prevent metadata publication or deletion of older recovery points.
 */
import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const template = readFileSync(
  new URL(
    "../cloud/terraform/hetzner/apps-shared/cloud-init/tenant-db.yaml.tftpl",
    import.meta.url,
  ),
  "utf8",
);
const start = template.indexOf("      export RCLONE_S3_PROVIDER=Other");
const end = template.indexOf("      ELAPSED=", start);
if (start < 0 || end < start)
  throw new Error("Backup publication boundaries not found");
const protocol = template
  .substring(start, end)
  .split("\n")
  .map((line) => line.replace(/^ {6}/, ""))
  .join("\n")
  .replaceAll("$${", "${");
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

function run(mode: string) {
  const root = mkdtempSync(join(tmpdir(), "tenant-backup-readback-"));
  roots.push(root);
  const ciphertext = Buffer.alloc(128 * 1024, 173);
  writeFileSync(join(root, "backup.tar.gz.enc"), ciphertext);
  writeFileSync(join(root, "backup.json"), '{"archive":"backup.tar.gz.enc"}');
  writeFileSync(join(root, "effects"), "");
  const prelude = `set -euo pipefail
log() { printf '%s\\n' "$*"; }
sha256sum() { shasum -a 256 "$@"; }
date() { printf '%s\\n' '20260102T000000Z'; }
rclone() {
  printf '%s\\n' "$*" >> effects
  case "$1" in
    copyto) cp "$2" "remote-$2" ;;
    cat)
      if [[ "$2" == */backup.tar.gz.enc ]]; then
        [ "$MODE" != archive-read-error ] || return 57
        if [ "$MODE" = archive-corrupt ]; then printf corrupted; else cat remote-backup.tar.gz.enc; fi
      else
        [ "$MODE" != metadata-read-error ] || return 58
        if [ "$MODE" = metadata-corrupt ]; then printf corrupted; else cat remote-backup.json; fi
      fi ;;
    lsf) printf '%s\\n' '20200101T000000Z/' ;;
    purge) printf '%s\\n' purged >> effects ;;
    *) return 90 ;;
  esac
}
`;
  const result = spawnSync("bash", ["-c", prelude + protocol], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      MODE: mode,
      BACKUP_S3_ENDPOINT: "https://objects.example.test",
      BACKUP_S3_BUCKET: "tenant-test",
      BACKUP_S3_PREFIX: "development/tenant-db",
      BACKUP_S3_ACCESS_KEY_ID: "fixture",
      BACKUP_S3_SECRET_ACCESS_KEY: "fixture",
      STAMP: "20260906T000000Z",
      BACKUP_RETENTION_DAYS: "30",
      ENC_SHA: createHash("sha256").update(ciphertext).digest("hex"),
    },
  });
  return { ...result, effects: readFileSync(join(root, "effects"), "utf8") };
}

test("verified archive and metadata permit scoped expiry only after both readbacks", () => {
  const result = run("healthy");
  expect(result.status).toBe(0);
  const effects = result.effects.split("\n");
  const archiveRead = effects.findIndex(
    (line) => line.startsWith("cat ") && line.endsWith("backup.tar.gz.enc"),
  );
  const metadataWrite = effects.findIndex((line) =>
    line.startsWith("copyto backup.json "),
  );
  const metadataRead = effects.findIndex(
    (line) => line.startsWith("cat ") && line.endsWith("backup.json"),
  );
  const purge = effects.findIndex((line) => line.startsWith("purge "));
  expect(archiveRead).toBeGreaterThanOrEqual(0);
  expect(metadataWrite).toBeGreaterThan(archiveRead);
  expect(metadataRead).toBeGreaterThan(metadataWrite);
  expect(purge).toBeGreaterThan(metadataRead);
  expect(effects[purge]).toBe(
    "purge :s3:tenant-test/development/tenant-db/20200101T000000Z",
  );
});

for (const mode of [
  "archive-read-error",
  "archive-corrupt",
  "metadata-read-error",
  "metadata-corrupt",
]) {
  test(`${mode} preserves older backup sets`, () => {
    const result = run(mode);
    expect(result.status).not.toBe(0);
    expect(result.effects).not.toContain("purge ");
    expect(result.effects).not.toContain("lsf ");
    if (mode.startsWith("archive"))
      expect(result.effects).not.toContain("copyto backup.json ");
  });
}
