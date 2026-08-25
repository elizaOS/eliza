/**
 * Behavioral regression for cloud/runners/repair-runner-slot.sh. The script is
 * executed for real against a fake systemd host: a temporary runner tree, a
 * fake /proc tree whose entries stand in for live runner processes, and
 * PATH-shadowed `id`, `systemctl`, `pgrep`, and `install` stubs.
 *
 * The fake /proc tree is what makes the process paths failure-sensitive rather
 * than decorative: each entry carries a real `cwd` symlink and a `cmdline`, so
 * the script's own cwd scoping decides which processes it reaps, and a fake
 * `kill` removes exactly the entries it TERMs. That covers the two invariants
 * this script exists for — the abandoned KillMode=process listener chain is
 * reaped (and a survivor aborts the repair), and the run fails unless exactly
 * one listener owns the slot afterwards, including when the duplicate surfaces
 * seconds after the first sighting — plus dry-run inertness, stale-unit
 * replacement, diagnostic preservation, sibling-slot isolation, argument
 * validation, and the refusal to honor host-path overrides outside the harness.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
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

/**
 * One entry in the fake /proc tree.
 *
 * `slot` picks which install root the process's cwd points at, so the script's
 * own cwd filter decides whether it is in scope. `appearsAfterStartCall` hides
 * the process until the Nth `pgrep` call that follows `systemctl start`, which
 * is how a listener that boots late — or a duplicate that surfaces after the
 * first one — is expressed. `survivesTerm` ignores the fake SIGTERM.
 */
interface FakeProcess {
  pid: number;
  slot: 20 | 21;
  listener?: boolean;
  survivesTerm?: boolean;
  appearsAfterStartCall?: number;
}

interface FakeHost {
  dir: string;
  runnersRoot: string;
  installRoot: string;
  unitPath: string;
  binDir: string;
  procDir: string;
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
 * that must never be touched), a colliding _diag/pages, a fake /proc tree, and
 * the command stubs the script talks to.
 */
function createFakeHost(options: {
  installedUnit?: string;
  processes?: readonly FakeProcess[];
}): FakeHost {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "runner-repair-")));
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

  const procDir = join(dir, "proc");
  mkdirSync(procDir, { recursive: true });
  for (const proc of options.processes ?? []) {
    const entry = join(procDir, String(proc.pid));
    mkdirSync(entry, { recursive: true });
    symlinkSync(
      proc.slot === 20 ? installRoot : siblingRoot,
      join(entry, "cwd"),
    );
    writeFileSync(
      join(entry, "cmdline"),
      proc.listener === false
        ? "/opt/actions-runners/bin/Runner.Worker\n"
        : "/opt/actions-runners/bin/Runner.Listener\n",
    );
    if (proc.survivesTerm) {
      writeFileSync(join(entry, ".immortal"), "");
    }
    if (proc.appearsAfterStartCall !== undefined) {
      writeFileSync(join(entry, ".appear"), `${proc.appearsAfterStartCall}\n`);
    }
  }

  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const systemctlLog = join(dir, "systemctl.log");
  const startMark = join(dir, "started");
  const pgrepCounter = join(dir, "pgrep-calls");

  // The script only ever asks for the numeric uid, and the harness is root.
  writeStub(binDir, "id", "echo 0");
  writeStub(
    binDir,
    "systemctl",
    `echo "$*" >>"${systemctlLog}"
[ "\${1:-}" = start ] && : >"${startMark}"
exit 0`,
  );
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
  // Reports every surviving /proc entry, honoring the post-start delay so a
  // late-appearing duplicate listener can be modeled.
  writeStub(
    binDir,
    "pgrep",
    `started=0
n=0
if [ -f "${startMark}" ]; then
  started=1
  n=$(( $(cat "${pgrepCounter}" 2>/dev/null || echo 0) + 1 ))
  echo "$n" >"${pgrepCounter}"
fi
found=0
for entry in "${procDir}"/*; do
  [ -d "$entry" ] || continue
  appear="$(cat "$entry/.appear" 2>/dev/null || true)"
  if [ -n "$appear" ]; then
    [ "$started" = 1 ] || continue
    [ "$n" -ge "$appear" ] || continue
  fi
  echo "\${entry##*/}"
  found=1
done
[ "$found" = 1 ]`,
  );
  // Stands in for the kill builtin: a TERMed process leaves /proc unless it is
  // explicitly modeled as surviving the signal.
  writeStub(
    binDir,
    "fake-kill",
    `pid="\${2:-}"
[ -d "${procDir}/$pid" ] || exit 1
[ -f "${procDir}/$pid/.immortal" ] || rm -rf "${procDir}/$pid"
exit 0`,
  );

  return {
    dir,
    runnersRoot,
    installRoot,
    unitPath,
    binDir,
    procDir,
    systemctlLog,
  };
}

function runRepair(
  fake: FakeHost,
  args: readonly string[],
  envOverrides: Record<string, string> = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("bash", [REPAIR_PATH, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${fake.binDir}:${process.env.PATH ?? ""}`,
      ELIZA_RUNNER_FAKE_HOST: "1",
      ELIZA_RUNNERS_ROOT: fake.runnersRoot,
      ELIZA_RUNNER_UNIT_PATH: fake.unitPath,
      ELIZA_RUNNER_SETTLE_SECS: "1",
      ELIZA_RUNNER_CONFIRM_SECS: "2",
      ELIZA_RUNNER_PROC_ROOT: fake.procDir,
      ELIZA_RUNNER_POLL_INTERVAL: "0.1",
      ELIZA_RUNNER_KILL_CMD: join(fake.binDir, "fake-kill"),
      ...envOverrides,
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

/**
 * Each case runs the real script end to end, spawning dozens of stub processes
 * across its settle and confirm loops; the default 5s per-test budget is not
 * enough on a loaded machine.
 */
const TEST_TIMEOUT_MS = 60_000;

/** The abandoned listener the old KillMode=process policy left behind. */
const ABANDONED_LISTENER: FakeProcess = { pid: 4242, slot: 20 };
/** The healthy listener systemd starts once the slot has been repaired. */
const RESTARTED_LISTENER: FakeProcess = {
  pid: 5100,
  slot: 20,
  appearsAfterStartCall: 1,
};

describe("repair-runner-slot.sh against a fake systemd host", () => {
  test(
    "dry run mutates nothing, kills nothing, and only queries status",
    () => {
      host = createFakeHost({
        installedUnit: STALE_CONTROL_GROUP_UNIT,
        processes: [ABANDONED_LISTENER],
      });
      const result = runRepair(host, ["20"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("DRY-RUN complete");
      expect(result.stdout).toContain("would TERM and await: 4242");
      expect(existsSync(join(host.procDir, "4242"))).toBe(true);
      expect(pagesEntries(host.installRoot)).toEqual(["pages"]);
      expect(
        readFileSync(
          join(host.installRoot, "_diag", "pages", "collision.log"),
          "utf8",
        ),
      ).toBe("boom\n");
      expect(readFileSync(host.unitPath, "utf8")).toBe(
        STALE_CONTROL_GROUP_UNIT,
      );
      // The only systemctl the dry run may issue is the read-only status probe.
      expect(readFileSync(host.systemctlLog, "utf8")).toBe(
        "--no-pager status actions-runner@20.service\n",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "reaps the abandoned listener chain and succeeds with exactly one owner",
    () => {
      host = createFakeHost({
        installedUnit: STALE_CONTROL_GROUP_UNIT,
        processes: [ABANDONED_LISTENER, RESTARTED_LISTENER],
      });
      const result = runRepair(host, ["20", "--apply"]);

      expect(result.stdout).toContain("kill -TERM 4242");
      expect(existsSync(join(host.procDir, "4242"))).toBe(false);
      expect(result.stdout).toContain("(count=1)");
      expect(result.stdout).toContain("slot 20 repaired");
      expect(result.status).toBe(0);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails when a second listener still owns the slot after the restart",
    () => {
      host = createFakeHost({
        installedUnit: CANONICAL_UNIT,
        processes: [
          RESTARTED_LISTENER,
          { pid: 5101, slot: 20, appearsAfterStartCall: 1 },
        ],
      });
      const result = runRepair(host, ["20", "--apply"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "expected exactly one listener for slot 20",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails when the duplicate listener only surfaces after the first sighting",
    () => {
      host = createFakeHost({
        installedUnit: CANONICAL_UNIT,
        processes: [
          RESTARTED_LISTENER,
          { pid: 5102, slot: 20, appearsAfterStartCall: 2 },
        ],
      });
      const result = runRepair(host, ["20", "--apply"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("(count=2)");
      expect(result.stderr).toContain(
        "expected exactly one listener for slot 20",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "aborts before touching the unit when a process survives TERM",
    () => {
      host = createFakeHost({
        installedUnit: STALE_CONTROL_GROUP_UNIT,
        processes: [{ pid: 4243, slot: 20, survivesTerm: true }],
      });
      const result = runRepair(host, ["20", "--apply"]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("processes still alive after TERM: 4243");
      // The unit install is downstream of the reap and must not have run.
      expect(readFileSync(host.unitPath, "utf8")).toBe(
        STALE_CONTROL_GROUP_UNIT,
      );
      expect(readFileSync(host.systemctlLog, "utf8")).not.toContain(
        "daemon-reload",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "fails when no listener comes back at all",
    () => {
      host = createFakeHost({ installedUnit: CANONICAL_UNIT, processes: [] });
      const result = runRepair(host, ["20", "--apply"]);

      expect(result.status).toBe(1);
      expect(result.stdout).toContain("(count=0)");
      expect(result.stderr).toContain(
        "expected exactly one listener for slot 20",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "replaces a stale control-group unit with the wrong slot path and user",
    () => {
      host = createFakeHost({
        installedUnit: STALE_CONTROL_GROUP_UNIT,
        processes: [RESTARTED_LISTENER],
      });
      const result = runRepair(host, ["20", "--apply"]);

      expect(result.status).toBe(0);
      expect(result.stdout).toContain("differs from the canonical template");
      expect(readFileSync(host.unitPath, "utf8")).toBe(CANONICAL_UNIT);
      const systemctl = readFileSync(host.systemctlLog, "utf8");
      expect(systemctl).toContain("daemon-reload");
      expect(systemctl).toContain("stop actions-runner@20.service");
      expect(systemctl).toContain("start actions-runner@20.service");
      // The pre-existing fragment is backed up, never discarded.
      const backups = readdirSync(join(host.dir, "etc", "systemd", "system"));
      expect(
        backups.some((f) => f.includes("issue-19708") && f.endsWith(".bak")),
      ).toBe(true);
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "preserves the colliding pages directory and never touches the sibling slot",
    () => {
      host = createFakeHost({
        installedUnit: STALE_CONTROL_GROUP_UNIT,
        processes: [
          ABANDONED_LISTENER,
          RESTARTED_LISTENER,
          { pid: 6021, slot: 21 },
        ],
      });
      const result = runRepair(host, ["20", "--apply"]);
      expect(result.status).toBe(0);

      const entries = pagesEntries(host.installRoot);
      expect(entries).toContain("pages");
      expect(entries.some((e) => e.startsWith("pages.issue-19708-"))).toBe(
        true,
      );
      const preserved = entries.find((e) => e.startsWith("pages.issue-19708-"));
      expect(preserved).toBeDefined();
      expect(
        readFileSync(
          join(host.installRoot, "_diag", String(preserved), "collision.log"),
          "utf8",
        ),
      ).toBe("boom\n");

      // The sibling slot's listener is out of the cwd scope and must survive,
      // and it must not count toward this slot's single-owner assertion.
      expect(existsSync(join(host.procDir, "6021"))).toBe(true);
      expect(result.stdout).not.toContain("kill -TERM 6021");
      const sibling = join(host.runnersRoot, "runner-21", "_diag");
      expect(readdirSync(sibling)).toEqual(["pages"]);
      expect(readFileSync(join(sibling, "pages", "sibling.log"), "utf8")).toBe(
        "keep\n",
      );
      expect(readFileSync(host.systemctlLog, "utf8")).not.toContain(
        "runner-21",
      );
      expect(readFileSync(host.systemctlLog, "utf8")).not.toContain("@21");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "installs the canonical unit when no fragment exists at all",
    () => {
      host = createFakeHost({ processes: [RESTARTED_LISTENER] });
      const result = runRepair(host, ["20", "--apply"]);
      expect(result.status).toBe(0);
      expect(readFileSync(host.unitPath, "utf8")).toBe(CANONICAL_UNIT);
      expect(readFileSync(host.systemctlLog, "utf8")).toContain(
        "daemon-reload",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "leaves an already-canonical unit alone and skips daemon-reload",
    () => {
      host = createFakeHost({
        installedUnit: CANONICAL_UNIT,
        processes: [RESTARTED_LISTENER],
      });
      const result = runRepair(host, ["20", "--apply"]);
      expect(result.status).toBe(0);
      expect(result.stdout).toContain("already matches the canonical template");
      expect(readFileSync(host.systemctlLog, "utf8")).not.toContain(
        "daemon-reload",
      );
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "validates arguments and the install root",
    () => {
      host = createFakeHost({ installedUnit: CANONICAL_UNIT });
      expect(runRepair(host, ["../etc"]).status).toBe(64);
      expect(runRepair(host, []).status).toBe(64);
      // Unknown flags and extra positionals must not silently degrade to a dry run.
      expect(runRepair(host, ["20", "--dry-run"]).status).toBe(64);
      expect(runRepair(host, ["20", "21"]).status).toBe(64);
      expect(runRepair(host, ["20", "--apply", "--apply"]).status).toBe(64);
      // --apply is positional-independent.
      expect(runRepair(host, ["--apply", "20"]).stdout).not.toContain(
        "DRY-RUN",
      );

      const missing = runRepair(host, ["99", "--apply"]);
      expect(missing.status).toBe(1);
      expect(missing.stderr).toContain("missing install root");
    },
    TEST_TIMEOUT_MS,
  );

  test(
    "refuses host-path overrides unless the fake-host flag is set",
    () => {
      host = createFakeHost({ installedUnit: CANONICAL_UNIT });
      for (const flag of ["", "0", "true"]) {
        const result = runRepair(host, ["20"], {
          ELIZA_RUNNER_FAKE_HOST: flag,
        });
        expect(result.status).toBe(78);
        expect(result.stderr).toContain("without ELIZA_RUNNER_FAKE_HOST=1");
      }
    },
    TEST_TIMEOUT_MS,
  );
});
