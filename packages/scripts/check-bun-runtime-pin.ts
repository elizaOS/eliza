#!/usr/bin/env node
/**
 * Gates installs on the repository's canonical Bun pin from
 * `.github/ci-bun-version.json` (the same pin `ci-bun-version-contract.ts`
 * enforces on CI). Two Bun processes take part in an install, and each can be
 * wrong independently: the installer that resolves dependencies and writes
 * `bun.lock` (exposed to lifecycle scripts as `npm_execpath`), and the `bun`
 * resolved from PATH that runs the postinstall chain's patch and build steps.
 * Bundler and resolution behavior differ across Bun versions, so both must be
 * the pinned release before any install-time work is trusted.
 *
 * The guard is the first root-postinstall link, so it fires after dependency
 * resolution: an off-pin install has already extracted packages and may have
 * rewritten `bun.lock` by the time this check can refuse it. Failure output
 * says so and gives the restore step instead of claiming the install was
 * prevented before work began.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_VERSION_FILE = ".github/ci-bun-version.json";
const PIN_PATTERN = /^(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;
const INSTALLER_PROBE_TIMEOUT_MS = 15_000;

function parsePin(value) {
  if (typeof value !== "string") return null;
  return PIN_PATTERN.test(value) ? value : null;
}

/**
 * Decide whether one observed Bun runtime satisfies the canonical pin. The pin
 * is an exact release identity: prerelease and build tags are part of the
 * version string the toolchain reports, so only a byte-equal concrete release
 * matches.
 */
export function decideBunRuntimePin(observed, canonicalVersion) {
  const canonical = parsePin(canonicalVersion);
  if (!canonical) {
    return {
      ok: false,
      message: `${CANONICAL_VERSION_FILE} must declare a concrete Bun semver pin, got ${JSON.stringify(canonicalVersion)}.`,
    };
  }
  if (typeof observed?.version !== "string" || observed.version.length === 0) {
    return {
      ok: false,
      message: `Bun ${observed?.role ?? "runtime"} pin check failed: no Bun version could be read from ${observed?.source ?? "the runtime"}. The repository requires exactly ${canonical} (${CANONICAL_VERSION_FILE}).`,
    };
  }
  const running = parsePin(observed.version);
  if (!running) {
    return {
      ok: false,
      message: `Bun ${observed.role} pin check failed: ${observed.source} reported ${JSON.stringify(observed.version)}, which is not a concrete Bun release. The repository requires exactly ${canonical} (${CANONICAL_VERSION_FILE}).`,
    };
  }
  if (running !== canonical) {
    return {
      ok: false,
      message: `Bun ${observed.role} pin check failed: ${observed.source} is Bun ${running}, repository pin ${canonical} (${CANONICAL_VERSION_FILE}).`,
    };
  }
  return { ok: true };
}

function remediation(canonical) {
  return `Install the pinned release with the official installer: curl -fsSL https://bun.sh/install | bash -s "bun-v${canonical}" (Windows: download the bun-v${canonical} release from https://github.com/oven-sh/bun/releases), then re-run the install. bash packages/scripts/bootstrap-linux-dev.sh also installs it repository-locally without sudo (Linux only).`;
}

const INSTALLER_PROBE_SCRIPT =
  'process.stdout.write(String(process.versions.bun ?? ""))';

/**
 * Ask the binary at `execpath` which Bun it is. Only a real Bun answers the
 * eval probe with a version; installer paths that fail to run (npm, pnpm or
 * yarn launchers, broken shims, missing files) return a failure reason
 * instead of a guess, so the caller can fail closed.
 */
function probeInstallerBunVersion(execpath) {
  const probe = spawnSync(execpath, ["-e", INSTALLER_PROBE_SCRIPT], {
    encoding: "utf8",
    timeout: INSTALLER_PROBE_TIMEOUT_MS,
  });
  if (probe.error) {
    return {
      ok: false,
      reason: `${execpath} could not be executed (${probe.error.code ?? probe.error.message ?? "unknown error"})`,
    };
  }
  if (probe.status !== 0) {
    const detail = (probe.stderr || probe.stdout || "").trim().slice(0, 200);
    return {
      ok: false,
      reason: `${execpath} exited ${probe.status ?? "with an unknown status"} when asked for its Bun version${detail ? `: ${detail}` : ""}`,
    };
  }
  return { ok: true, version: probe.stdout.trim() };
}

function installerMismatch(execpath, probe, canonical) {
  const observed = probe.ok
    ? `is Bun ${probe.version} at ${execpath}`
    : `could not be established — ${probe.reason}`;
  return `Bun installer pin check failed: the runtime that performed this install ${observed}; the repository requires the install to be performed by exactly Bun ${canonical} (${CANONICAL_VERSION_FILE}).`;
}

const INSTALLER_AFTERMATH =
  "The installer has already resolved dependencies, so bun.lock may have been rewritten (git checkout -- bun.lock restores it) and packages were extracted before this check.";

function postinstallMismatch(installerVersion, installerExecpath, canonical) {
  return `Bun postinstall pin check failed: the postinstall chain runs Bun ${process.versions.bun} (the bun resolved from PATH), repository pin ${canonical} (${CANONICAL_VERSION_FILE}). The install itself was performed by Bun ${installerVersion} at ${installerExecpath}, which matches the pin. This check is the first postinstall link, so no patch or build step has run; place Bun ${canonical} first on PATH and re-run the install.`;
}

function installerExecpath() {
  const value = process.env.npm_execpath;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? path.resolve(trimmed) : "";
}

/**
 * Enforce the canonical Bun pin. In installer context (the root postinstall
 * wiring passes no override) both participants are required and a missing
 * `npm_execpath` fails closed. `--no-installer-context` is the explicit
 * manual mode: it verifies only the running Bun and its output says so.
 */
export function assertBunRuntimePin(
  repoRoot,
  { pinFile = CANONICAL_VERSION_FILE, installerContext = true } = {},
) {
  const canonical = parsePin(
    JSON.parse(readFileSync(path.resolve(repoRoot, pinFile), "utf8")).version,
  );
  if (!canonical) {
    throw new TypeError(`${pinFile} must declare a concrete Bun semver pin.`);
  }

  if (!installerContext) {
    const decision = decideBunRuntimePin(
      {
        role: "runtime",
        source: "the running Bun",
        version: process.versions.bun ?? "",
      },
      canonical,
    );
    if (!decision.ok) {
      throw new Error(`${decision.message}\n${remediation(canonical)}`);
    }
    return {
      ok: true,
      summary: `running Bun ${process.versions.bun} == pinned ${canonical}`,
    };
  }

  const execpath = installerExecpath();
  if (execpath === null || execpath === "") {
    throw new Error(
      `Bun installer pin check failed: the lifecycle environment did not expose npm_execpath, so the Bun runtime that performed this install could not be established. The repository requires the install to be performed by exactly Bun ${canonical} (${CANONICAL_VERSION_FILE}).\n${INSTALLER_AFTERMATH}\n${remediation(canonical)}`,
    );
  }

  // Fast path: when the lifecycle child was launched by the same binary that
  // is running this check, the installer's version is the running version and
  // the eval probe can be skipped.
  const installer =
    execpath === path.resolve(process.execPath)
      ? { ok: true, version: process.versions.bun ?? "" }
      : probeInstallerBunVersion(execpath);
  const installerDecision = decideBunRuntimePin(
    installer.ok
      ? { role: "installer", source: execpath, version: installer.version }
      : {
          role: "installer",
          source: `the install performed by ${execpath}`,
          version: "",
        },
    canonical,
  );
  if (!installerDecision.ok) {
    throw new Error(
      `${installerMismatch(execpath, installer, canonical)}\n${INSTALLER_AFTERMATH}\n${remediation(canonical)}`,
    );
  }

  const postinstallDecision = decideBunRuntimePin(
    {
      role: "postinstall",
      source: "the bun resolved from PATH",
      version: process.versions.bun ?? "",
    },
    canonical,
  );
  if (!postinstallDecision.ok) {
    throw new Error(
      `${postinstallMismatch(installer.version, execpath, canonical)}\n${remediation(canonical)}`,
    );
  }

  return {
    ok: true,
    summary: `installer ${execpath} = Bun ${installer.version}, postinstall Bun ${process.versions.bun} == pinned ${canonical}`,
  };
}

function parseArguments(args) {
  let pinFile = CANONICAL_VERSION_FILE;
  let installerContext = true;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--pin-file") {
      const value = args[index + 1];
      if (!value) throw new Error("--pin-file requires a path");
      pinFile = path.resolve(value);
      index += 1;
    } else if (args[index] === "--no-installer-context") {
      installerContext = false;
    } else {
      throw new Error(`unknown argument: ${args[index]}`);
    }
  }
  return { pinFile, installerContext };
}

const scriptPath = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) === scriptPath) {
  const repoRoot = path.resolve(path.dirname(scriptPath), "../..");
  try {
    const { pinFile, installerContext } = parseArguments(process.argv.slice(2));
    const result = assertBunRuntimePin(repoRoot, { pinFile, installerContext });
    const scope = installerContext
      ? result.summary
      : `${result.summary} (manual check: npm_execpath is unset, so no installer runtime was verified)`;
    process.stdout.write(`Bun runtime pin check passed (${scope}).\n`);
  } catch (error) {
    // error-policy:J1 the CLI translates pin mismatches into a non-zero
    // install result with the detected and required runtimes named.
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
