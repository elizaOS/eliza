import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function install(mode: string, isolated: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "apt-source-test-"));
  try {
    writeFileSync(
      join(dir, "sudo"),
      `#!/usr/bin/env bash
if [ "$1" = -n ]; then shift; fi
case "$1" in
  true) exit 0 ;;
  test) [ "$APT_TEST_MODE" != missing ]; exit $? ;;
  tee) cat >/dev/null; exit 0 ;;
  apt-get)
    printf '%s\\n' "$*" >> "$APT_TEST_LOG"
    if [ "$APT_TEST_MODE" = unavailable ]; then exit 100; fi
    if [ "$APT_TEST_MODE" = unrelated ]; then
      [[ "$*" == *Dir::Etc::sourcelist=/etc/apt/sources.list.d/ubuntu.sources* && "$*" == *Dir::Etc::sourceparts=-* ]] || exit 100
    fi
    exit 0 ;;
esac
exit 90
`,
      { mode: 0o755 },
    );
    writeFileSync(join(dir, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const log = join(dir, "commands");
    writeFileSync(log, "");
    const result = spawnSync(
      "bash",
      [
        new URL("./install-apt-packages.sh", import.meta.url).pathname,
        "--no-install-recommends",
        "qemu-utils",
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${dir}:${process.env.PATH}`,
          ELIZA_APT_UBUNTU_ONLY: String(isolated),
          APT_TEST_MODE: mode,
          APT_TEST_LOG: log,
        },
      },
    );
    return { ...result, commands: readFileSync(log, "utf8") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("Ubuntu-only installs exclude unrelated feeds for both update and install", () => {
  const result = install("unrelated", true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.commands.trim().split("\n").length, 2);
  for (const command of result.commands.trim().split("\n")) {
    assert.match(
      command,
      /Dir::Etc::sourcelist=\/etc\/apt\/sources.list.d\/ubuntu.sources/,
    );
    assert.match(command, /Dir::Etc::sourceparts=-/);
  }
  assert.match(
    result.commands,
    /install -y .*--no-install-recommends qemu-utils/,
  );
});

test("ordinary callers preserve configured package sources", () => {
  const result = install("healthy", false);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.commands, /Dir::Etc/);
});

test("missing Ubuntu configuration fails before package operations", () => {
  const result = install("missing", true);
  assert.equal(result.status, 1);
  assert.equal(result.commands, "");
  assert.match(result.stderr, /repository configuration is missing/);
});

test("required repository failures remain hard errors after bounded retries", () => {
  const result = install("unavailable", true);
  assert.equal(result.status, 1);
  assert.equal(result.commands.trim().split("\n").length, 5);
  assert.match(result.stdout, /failed after 5 attempts/);
});
