#!/usr/bin/env node
/**
 * Resolves the Python 3.13 runtime used by the canonical skill packager and
 * installs its hash-pinned dependencies. The explicit minor version keeps the
 * selected wheel set identical across local and CI execution.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const localEnvironmentRoot = resolve(packageRoot, ".venv");
const localSkillPython = resolve(
  localEnvironmentRoot,
  process.platform === "win32" ? "Scripts/python.exe" : "bin/python",
);
export const skillPythonRequirements = resolve(
  packageRoot,
  "..",
  "skills",
  "skills",
  "skill-creator",
  "requirements.txt",
);

export function resolveSkillPython() {
  const candidates = [
    process.env.ELIZA_SKILL_PYTHON,
    localSkillPython,
    "python3.13",
    "python3",
    "python",
  ].filter(
    (candidate, index, all) => candidate && all.indexOf(candidate) === index,
  );

  for (const candidate of candidates) {
    const probe = spawnSync(
      candidate,
      [
        "-c",
        "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')",
      ],
      { encoding: "utf8" },
    );
    if (probe.status === 0 && probe.stdout.trim() === "3.13") {
      return candidate;
    }
  }

  throw new Error(
    "[ElizaComputer] Python 3.13 is required for the hash-pinned skill packager. Install it or set ELIZA_SKILL_PYTHON to its executable.",
  );
}

export function installSkillPythonDependencies() {
  const configuredPython = process.env.ELIZA_SKILL_PYTHON;
  let python = configuredPython;
  if (!python) {
    const basePython = ["python3.13", "python3", "python"].find((candidate) => {
      const probe = spawnSync(
        candidate,
        ["-c", "import sys; raise SystemExit(sys.version_info[:2] != (3, 13))"],
        { stdio: "ignore" },
      );
      return probe.status === 0;
    });
    if (!basePython) {
      throw new Error(
        "[ElizaComputer] Python 3.13 is required for the hash-pinned skill packager.",
      );
    }
    execFileSync(basePython, ["-m", "venv", localEnvironmentRoot], {
      stdio: "inherit",
    });
    python = localSkillPython;
  }
  const selectedVersion = spawnSync(
    python,
    ["-c", "import sys; raise SystemExit(sys.version_info[:2] != (3, 13))"],
    { stdio: "ignore" },
  );
  if (selectedVersion.status !== 0) {
    throw new Error(
      `[ElizaComputer] Configured skill Python is not Python 3.13: ${python}`,
    );
  }
  execFileSync(
    python,
    [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "--only-binary=:all:",
      "--require-hashes",
      "--requirement",
      skillPythonRequirements,
    ],
    { stdio: "inherit" },
  );
  return python;
}

export function requireSkillPythonDependencies() {
  const python = resolveSkillPython();
  try {
    execFileSync(python, ["-c", "import yaml"], { stdio: "pipe" });
  } catch (cause) {
    throw new Error(
      `[ElizaComputer] Python skill-packager dependencies are unavailable. Run bun run --cwd packages/eliza-computer setup:python (requirements: ${skillPythonRequirements}).`,
      { cause },
    );
  }
  return python;
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  if (process.argv[2] !== "install") {
    throw new Error("Usage: node scripts/python-runtime.mjs install");
  }
  installSkillPythonDependencies();
}
