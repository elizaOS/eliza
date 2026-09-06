/**
 * Exercises the actual bootstrap shell gates with temporary files and substituted
 * block-device commands. Initialization races use real filesystem hard links;
 * PostgreSQL, mounts and systemd remain external boundary fixtures.
 */
import { afterEach, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const template = readFileSync(
  new URL(
    "../cloud/terraform/hetzner/apps-shared/cloud-init/tenant-db.yaml.tftpl",
    import.meta.url,
  ),
  "utf8",
);
function section(start: string, end: string): string {
  const begin = template.indexOf(start);
  const finish = template.indexOf(end, begin);
  if (begin < 0 || finish < 0)
    throw new Error("Bootstrap protocol boundaries changed");
  return template
    .substring(begin, finish)
    .split("\n")
    .map((line) => line.replace(/^ {6}/, ""))
    .join("\n");
}
const volumeGate = section(
  "      # Bind initialization",
  "      # 4. Postgres version detection",
).replace(
  "${tenant_db_volume_device}",
  "/dev/disk/by-id/scsi-0HC_Volume_12345",
);
const clusterGate = section(
  "      # Existing clusters must match",
  "      # 6. postgresql.conf",
);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const volume = "/dev/disk/by-id/scsi-0HC_Volume_12345";
const volumePrelude = `set -euo pipefail
log() { :; }
test() { if [ "$1" = '-b' ]; then [ "$BLOCK_PRESENT" = '1' ]; else builtin test "$@"; fi; }
blkid() { [ "$PROBE_OK" = '1' ] || return 2; printf '%s\\n' "$FS_TYPE"; }
lsblk() { printf '%s\\n' "$EXPECTED_DEVICE"; }
mkdir() { :; }
mountpoint() { [ "$ALREADY_MOUNTED" = '1' ]; }
mount() { printf '%s\\n' "$*" >> "$EFFECTS"; [ "$MOUNT_OK" = '1' ]; }
findmnt() { printf '%s\\n' "$OBSERVED_DEVICE"; }
`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "tenant-bootstrap-"));
  roots.push(root);
  const data = join(root, "data");
  const authorizationRoot = join(root, "authorization");
  mkdirSync(data);
  mkdirSync(authorizationRoot);
  return {
    root,
    data,
    authorizationRoot,
    receipt: join(authorizationRoot, "authorization"),
    effects: join(root, "effects"),
  };
}
function effects(path: string) {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}
const volumeCases: Array<[string, Record<string, string>, boolean, boolean]> = [
  ["missing volume", { BLOCK_PRESENT: "0" }, false, false],
  ["failed filesystem probe", { PROBE_OK: "0" }, false, false],
  ["unexpected filesystem", { FS_TYPE: "xfs" }, false, false],
  [
    "ambiguous device identity",
    { EXPECTED_DEVICE: "8:16\n8:17" },
    false,
    false,
  ],
  ["correct existing mount", {}, true, false],
  ["wrong existing mount", { OBSERVED_DEVICE: "8:17" }, false, false],
  ["mount assigned volume", { ALREADY_MOUNTED: "0" }, true, true],
  ["lost mount response", { ALREADY_MOUNTED: "0", MOUNT_OK: "0" }, false, true],
  [
    "mismatched mount readback",
    { ALREADY_MOUNTED: "0", OBSERVED_DEVICE: "8:17" },
    false,
    true,
  ],
];
for (const [name, overrides, allowed, mounted] of volumeCases) {
  test(`volume admission: ${name}`, () => {
    const f = fixture();
    const result = spawnSync(
      "bash",
      ["-c", `${volumePrelude}${volumeGate}\necho INITIALIZATION_ALLOWED\n`],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          BLOCK_PRESENT: "1",
          PROBE_OK: "1",
          FS_TYPE: "ext4",
          EXPECTED_DEVICE: "8:16",
          ALREADY_MOUNTED: "1",
          MOUNT_OK: "1",
          OBSERVED_DEVICE: "8:16",
          EFFECTS: f.effects,
          ...overrides,
        },
      },
    );
    expect(result.status === 0).toBe(allowed);
    expect(result.stdout.includes("INITIALIZATION_ALLOWED")).toBe(allowed);
    expect(effects(f.effects)).toBe(
      mounted ? `--source ${volume} --target /mnt/tenant-pgdata\n` : "",
    );
  });
}
function cluster(
  f: ReturnType<typeof fixture>,
  overrides: Record<string, string> = {},
) {
  const source = clusterGate
    .replaceAll("/mnt/tenant-pgdata", f.data)
    .replaceAll("/run/eliza-tenant-db-init", f.authorizationRoot);
  const prelude = `set -euo pipefail
log() { :; }
stat() { if [ "$3" = "$AUTH_ROOT" ]; then echo "$AUTH_ROOT_MODE"; elif [ "$2" = '%Y' ]; then echo "$ISSUED_AT"; else echo "$AUTH_MODE"; fi; }
systemctl() { :; }
chown() { :; }
runuser() { echo INITIALIZED >> "$EFFECTS"; [ "$INIT_OK" = '1' ]; }
findmnt() { printf '%s\\n' "$DATA_DEVICE"; }
`;
  return {
    script: prelude + source,
    env: {
      PATH: process.env.PATH,
      VOL: volume,
      PGDATA: join(f.data, "16/main"),
      PGVER: "16",
      AUTH_ROOT: f.authorizationRoot,
      AUTH_ROOT_MODE: "0:700",
      AUTH_MODE: "0:600",
      ISSUED_AT: String(Math.floor(Date.now() / 1000) - 1),
      EFFECTS: f.effects,
      INIT_OK: "1",
      expected_device: "8:16",
      DATA_DEVICE: "8:16",
      ...overrides,
    },
  };
}
function runCluster(
  f: ReturnType<typeof fixture>,
  overrides: Record<string, string> = {},
) {
  const command = cluster(f, overrides);
  return spawnSync("bash", ["-c", command.script], {
    env: command.env,
    encoding: "utf8",
  });
}
function authorize(f: ReturnType<typeof fixture>, value = volume) {
  writeFileSync(f.receipt, value, { mode: 0o600 });
}

test("permits startup of an existing matching cluster without an initialization grant", () => {
  const f = fixture();
  mkdirSync(join(f.data, "16/main"), { recursive: true });
  writeFileSync(join(f.data, "16/main/PG_VERSION"), "16\n");
  expect(runCluster(f).status).toBe(0);
  expect(effects(f.effects)).toBe("");
});
test("does not initialize over a mismatched or unrecognized existing cluster", () => {
  for (const marker of ["15\n", ""]) {
    const f = fixture();
    mkdirSync(join(f.data, "16/main"), { recursive: true });
    if (marker) writeFileSync(join(f.data, "16/main/PG_VERSION"), marker);
    authorize(f);
    expect(runCluster(f).status).not.toBe(0);
    expect(effects(f.effects)).toBe("");
  }
});
test("does not initialize while filesystem recovery data remains", () => {
  const f = fixture();
  mkdirSync(join(f.data, "lost+found"));
  writeFileSync(join(f.data, "lost+found/recovered"), "data");
  authorize(f);
  expect(runCluster(f).status).not.toBe(0);
  expect(effects(f.effects)).toBe("");
});
test("requires a private, current, volume-bound authorization", () => {
  const invalid: Array<Record<string, string>> = [
    { AUTH_MODE: "501:600" },
    { AUTH_MODE: "0:666" },
    { AUTH_ROOT_MODE: "0:777" },
    { ISSUED_AT: "1" },
    { ISSUED_AT: String(Math.floor(Date.now() / 1000) + 600) },
  ];
  for (const overrides of invalid) {
    const f = fixture();
    authorize(f);
    expect(runCluster(f, overrides).status).not.toBe(0);
    expect(effects(f.effects)).toBe("");
  }
  for (const value of [null, "/dev/disk/by-id/scsi-0HC_Volume_67890"]) {
    const f = fixture();
    if (value) authorize(f, value);
    expect(runCluster(f).status).not.toBe(0);
    expect(effects(f.effects)).toBe("");
  }
});
test("rejects a symlinked authorization", () => {
  const f = fixture();
  const target = join(f.root, "other");
  writeFileSync(target, volume);
  symlinkSync(target, f.receipt);
  expect(runCluster(f).status).not.toBe(0);
  expect(effects(f.effects)).toBe("");
});
test("consumes initialization authority even if initdb fails", () => {
  const f = fixture();
  authorize(f);
  expect(runCluster(f, { INIT_OK: "0" }).status).not.toBe(0);
  expect(existsSync(f.receipt)).toBe(false);
  expect(readFileSync(`${f.receipt}.consumed`, "utf8")).toBe(volume);
  expect(runCluster(f).status).not.toBe(0);
  expect(effects(f.effects)).toBe("INITIALIZED\n");
});
test("concurrent initializers consume one actual filesystem receipt", async () => {
  const f = fixture();
  authorize(f);
  const command = cluster(f);
  const run = () =>
    new Promise<number | null>((resolve, reject) => {
      const child = spawn("bash", ["-c", command.script], {
        env: command.env,
        stdio: "ignore",
      });
      child.once("error", reject);
      child.once("exit", resolve);
    });
  const results = await Promise.all([run(), run()]);
  expect(results.filter((code) => code === 0)).toHaveLength(1);
  expect(effects(f.effects)).toBe("INITIALIZED\n");
  expect(existsSync(f.receipt)).toBe(false);
});

test("rejects redirected data directories and mounts beneath the volume", () => {
  const f = fixture();
  mkdirSync(join(f.data, "16/main"), { recursive: true });
  writeFileSync(join(f.data, "16/main/PG_VERSION"), "16\n");
  expect(runCluster(f, { DATA_DEVICE: "8:17" }).status).not.toBe(0);
  expect(effects(f.effects)).toBe("");
  const other = fixture();
  mkdirSync(join(other.data, "16"));
  symlinkSync(join(f.data, "16/main"), join(other.data, "16/main"));
  expect(runCluster(other).status).not.toBe(0);
  expect(effects(other.effects)).toBe("");
});
