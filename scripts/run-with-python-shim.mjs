#!/usr/bin/env node

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const USAGE =
  "Usage: node scripts/run-with-python-shim.mjs <command> [args...]";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseVersion(rawVersion) {
  const match = /^(\d+)\.(\d+)$/.exec(rawVersion);
  if (!match) {
    fail(`Invalid Python version "${rawVersion}". Expected <major.minor>.`);
  }

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
  };
}

function versionAtLeast(candidate, minimum) {
  return (
    candidate.major > minimum.major ||
    (candidate.major === minimum.major && candidate.minor >= minimum.minor)
  );
}

function resolvePython(minimumVersion = "3.11") {
  const minimum = parseVersion(minimumVersion);
  const candidates = [
    process.env.PYTHON_BIN,
    "python3.13",
    "python3.12",
    "python3.11",
    "python3",
    "python",
  ].filter(Boolean);

  const seen = new Set();
  for (const candidate of candidates) {
    if (seen.has(candidate)) {
      continue;
    }
    seen.add(candidate);

    const probe = spawnSync(
      candidate,
      ["-c", 'import sys; print(f"{sys.version_info[0]}.{sys.version_info[1]}")'],
      { encoding: "utf8" },
    );

    if (probe.error || probe.status !== 0) {
      continue;
    }

    const version = parseVersion(probe.stdout.trim());
    if (versionAtLeast(version, minimum)) {
      return candidate;
    }
  }

  fail(
    `No Python interpreter >= ${minimumVersion} found. Set PYTHON_BIN or add python3.11+ to PATH.`,
  );
}

async function writeExecutable(filePath, content) {
  await writeFile(filePath, content, { mode: 0o755 });
  await chmod(filePath, 0o755);
}

function shellQuote(value) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

async function createShimDir(realPython) {
  const shimDir = await mkdtemp(path.join(tmpdir(), "eliza-python-shim-"));
  const quotedPython = shellQuote(realPython);
  const pythonWrapper = `#!/bin/sh
real_python=${quotedPython}
if [ "$1" = "-m" ] && [ "$2" = "venv" ] && [ -n "$3" ]; then
  "$real_python" "$@" || exit $?
  "$3/bin/python" -m pip install -q --upgrade pip setuptools wheel || exit $?
  exit 0
fi
if [ "$1" = "-m" ] && [ "$2" = "build" ]; then
  tmpdir=$(mktemp -d)
  "$real_python" -m venv "$tmpdir" || exit $?
  "$tmpdir/bin/python" -m pip install -q --upgrade pip setuptools wheel build || exit $?
  shift 2
  "$tmpdir/bin/python" -m build "$@"
  status=$?
  rm -rf "$tmpdir"
  exit $status
fi
exec "$real_python" "$@"
`;
  const pyprojectBuildWrapper = `#!/bin/sh
real_python=${quotedPython}
tmpdir=$(mktemp -d)
"$real_python" -m venv "$tmpdir" || exit $?
"$tmpdir/bin/python" -m pip install -q --upgrade pip setuptools wheel build || exit $?
"$tmpdir/bin/python" -m build "$@"
status=$?
rm -rf "$tmpdir"
exit $status
`;

  await Promise.all([
    writeExecutable(path.join(shimDir, "python3"), pythonWrapper),
    writeExecutable(path.join(shimDir, "python"), pythonWrapper),
    writeExecutable(path.join(shimDir, "pyproject-build"), pyprojectBuildWrapper),
  ]);

  return {
    env: {
      ...process.env,
      PYTHON_BIN: realPython,
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
    },
    shimDir,
  };
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command) {
    fail(USAGE);
  }

  const realPython = resolvePython();
  const { env, shimDir } = await createShimDir(realPython);

  try {
    const child = spawnSync(command, args, {
      stdio: "inherit",
      env,
      shell: process.platform === "win32",
    });

    if (child.error) {
      throw child.error;
    }

    process.exit(child.status ?? 1);
  } finally {
    await rm(shimDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
