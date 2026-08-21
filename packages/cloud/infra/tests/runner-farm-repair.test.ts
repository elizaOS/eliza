/**
 * Behavioral regression for cloud/runners/repair-runner-slot.sh. The script is
 * executed for real against a fake systemd host: a temporary runner tree plus
 * PATH-shadowed `id`, `systemctl`, `pgrep`, and `install` stubs, with the host
 * paths redirected through ELIZA_RUNNERS_ROOT / ELIZA_RUNNER_UNIT_PATH.
 *
 * These cover what string assertions cannot: that a dry run mutates nothing,
 * that a stale unit which already says KillMode=control-group but points at
 * the wrong slot path/user is still replaced and daemon-reloaded, that the
 * colliding _diag/pages directory is preserved rather than deleted, and that
 * the process reap never reaches a sibling slot.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPAIR_PATH = join(
  import.meta.dir,
  "..",
  "cloud",
  "runners",
  "repair-runner-slot.sh",
);
const CANONICAL_UNIT = readFileSync(
  join(import.meta.dir, "..", "cloud", "runners", "actions-runner@.service"),
  "utf8",
);

/** A control-group unit that is nonetheless stale: wrong slot path and user. */
const STALE_CONTROL_GROUP_UNIT = `[Unit]
Description=old hand-provisioned runner %i

[Service]
Type=simple
User=runner
Group=runner
WorkingDirectory=/home/runner/actions-runner
ExecStart=/home/runner/actions-runner/runsvc.sh
KillMode=control-group

[Install]
WantedBy=multi-user.target
`;

interface FakeHost {
  dir: string;
  runnersRoot: string;
  installRoot: string;
  unitPath: string;
  binDir: string;
  systemctlLog: string;
}

let host: FakeHost | null = null;

afterEach(() => {
  if (host) {
    rmSync(host.dir, { recursive: true, force: true });
    host = null;
  }
});

function writeStub(binDir: string, name: string, body: string): void {
  const file = join(binDir, name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

/**
 * Builds a throwaway host: two runner slots (20 under repair, 21 a sibling
 * that must never be touched), a colliding _diag/pages, and command stubs.
 * `listenerPids` is what the fake pgrep reports.
 */
function createFakeHost(options: {
  installedUnit?: string;
  listenerPids?: readonly number[];
}): FakeHost {
  const dir = mkdtempSync(join(tmpdir(), "runner-repair-"));
  const runnersRoot = join(dir, "opt", "actions-runners");
  const installRoot = join(runnersRoot, "runner-20");
  const siblingRoot = join(runnersRoot, "runner-21");
  mkdirSync(join(installRoot, "_diag", "pages"), { recursive: true });
  mkdirSync(join(siblingRoot, "_diag", "pages"), { recursive: true });
  writeFileSync(join(installRoot, "_diag", "pages", "collision.log"), "boom\n");
  writeFileSync(join(siblingRoot, "_diag", "pages", "sibling.log"), "keep\n");

  const unitDir = join(dir, "etc", "systemd", "system");
  mkdirSync(unitDir, { recursive: true });
  const unitPath = join(unitDir, "actions-runner@.service");
  if (options.installedUnit !== undefined) {
    writeFileSync(unitPath, options.installedUnit);
  }

  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const systemctlLog = join(dir, "systemctl.log");

  writeStub(binDir, "id", 'if [ "${1:-}" = "-u" ]; then echo 0; else echo 0; fi');
  writeStub(binDir, "systemctl", `echo "$*" >>"${systemctlLog}"; exit 0`);
  // Ownership flags are meaningless in a throwaway tree; honor the rest.
  writeStub(
    binDir,
    "install",
    `args=(); dirmode=false
for a in "$@"; do
  case "$a" in
    -d) dirmode=true ;;
    -o|-g|-m) skip=1 ;;
    *) if [ "\${skip:-0}" = 1 ]; then skip=0; else args+=("$a"); fi ;;
  esac
done
if $dirmode; then mkdir -p "\${args[@]}"; else
  src="\${args[0]}"; dst="\${args[1]}"; cp "$src" "$dst"; fi`,
  );
  const pids = options.listenerPids ?? [];
  writeStub(
    binDir,
    "pgrep",
    pids.length > 0 ? `printf '%s\\n' ${pids.join(" ")}` : "exit 1",
  );

  return { dir, runnersRoot, installRoot, unitPath, binDir, systemctlLog };
}

function runRepair(
  fake: FakeHost,
  args: readonly string[],
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [REPAIR_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
      ELIZA_RUNNERS_ROOT: fake.runnersRoot,
      ELIZA_RUNNER_UNIT_PATH: fake.unitPath,
      ELIZA_RUNNER_SETTLE_SECS: "1",
    },
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function pagesEntries(installRoot: string): string[] {
  return readdirSync(join(installRoot, "_diag")).sort();
}

describe("repair-runner-slot.sh against a fake systemd host", () => {
  test("dry run mutates nothing and issues only a read-only status query", () => {
    host = createFakeHost({ installedUnit: STALE_CONTROL_GROUP_UNIT });
    const result = runRepair(host, ["20"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("DRY-RUN complete");
    expect(pagesEntries(host.installRoot)).toEqual(["pages"]);
    expect(
      readFileSync(join(host.installRoot, "_diag", "pages", "collision.log"), "utf8"),
    ).toBe("boom\n");
    expect(readFileSync(host.unitPath, "utf8")).toBe(STALE_CONTROL_GROUP_UNIT);
    // The only systemctl the dry run may issue is the read-only status probe.
    expect(readFileSync(host.systemctlLog, "utf8")).toBe(
      "--no-pager status actions-runner@20.service\n",
    );
  });

  test("replaces a stale control-group unit with the wrong slot path and user", () => {
    host = createFakeHost({
      installedUnit: STALE_CONTROL_GROUP_UNIT,
      listenerPids: [],
    });
    const result = runRepair(host, ["20", "--apply"]);

    // No listener can be faked into existence here, so the run reaches the
    // single-listener assertion and fails there; the unit install must
    // already have happened by then.
    expect(result.stdout).toContain("differs from the canonical template");
    expect(readFileSync(host.unitPath, "utf8")).toBe(CANONICAL_UNIT);
    const systemctl = readFileSync(host.systemctlLog, "utf8");
    expect(systemctl).toContain("daemon-reload");
    expect(systemctl).toContain("stop actions-runner@20.service");
    expect(systemctl).toContain("start actions-runner@20.service");
    // The pre-existing fragment is backed up, never discarded.
    const backups = readdirSync(join(host.dir, "etc", "systemd", "system"));
    expect(backups.some((f) => f.includes("issue-19708") && f.endsWith(".bak"))).toBe(
      true,
    );
  });

  test("preserves the colliding pages directory and never touches the sibling slot", () => {
    host = createFakeHost({ installedUnit: STALE_CONTROL_GROUP_UNIT });
    runRepair(host, ["20", "--apply"]);

    const entries = pagesEntries(host.installRoot);
    expect(entries).toContain("pages");
    expect(entries.some((e) => e.startsWith("pages.issue-19708-"))).toBe(true);
    const preserved = entries.find((e) => e.startsWith("pages.issue-19708-"));
    expect(
      readFileSync(join(host.installRoot, "_diag", preserved!, "collision.log"), "utf8"),
    ).toBe("boom\n");

    const sibling = join(host.runnersRoot, "runner-21", "_diag");
    expect(readdirSync(sibling)).toEqual(["pages"]);
    expect(readFileSync(join(sibling, "pages", "sibling.log"), "utf8")).toBe("keep\n");
    expect(readFileSync(host.systemctlLog, "utf8")).not.toContain("runner-21");
    expect(readFileSync(host.systemctlLog, "utf8")).not.toContain("@21");
  });

  test("installs the canonical unit when no fragment exists at all", () => {
    host = createFakeHost({});
    runRepair(host, ["20", "--apply"]);
    expect(readFileSync(host.unitPath, "utf8")).toBe(CANONICAL_UNIT);
    expect(readFileSync(host.systemctlLog, "utf8")).toContain("daemon-reload");
  });

  test("leaves an already-canonical unit alone and skips daemon-reload", () => {
    host = createFakeHost({ installedUnit: CANONICAL_UNIT });
    const result = runRepair(host, ["20", "--apply"]);
    expect(result.stdout).toContain("already matches the canonical template");
    expect(readFileSync(host.systemctlLog, "utf8")).not.toContain("daemon-reload");
  });

  test("rejects a non-numeric slot and a missing install root", () => {
    host = createFakeHost({ installedUnit: CANONICAL_UNIT });
    expect(runRepair(host, ["../etc"]).status).toBe(64);
    expect(runRepair(host, []).status).toBe(64);
    const missing = runRepair(host, ["99", "--apply"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("missing install root");
  });
});
