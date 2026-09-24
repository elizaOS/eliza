/**
 * Chooses the JS runtime (bun vs node) for launching the app: honors
 * ELIZA_RUNTIME, avoids the known-unstable Bun 1.3.9-on-Linux combination,
 * enforces a minimum Node major, and resolves executable paths for the launcher
 * scripts.
 */
import { spawnSync } from "node:child_process";

const KNOWN_UNSTABLE_BUN_LINUX = /^1\.3\.9(?:$|[-+].*)/;
const MIN_NODE_MAJOR = 24;
/** Exact per-line probe markers only — never mid-line noise such as `(node:123)`. */
const EXACT_NODE_PROBE_LINE = /^node:(.+)$/;
const EXACT_BUN_PROBE_LINE = /^bun$/;

/**
 * Builds the child-process env for the Node runtime probe. Inherits PATH and
 * other discovery-related vars, but strips NODE_OPTIONS so caller preloads
 * cannot write to stdout and corrupt version detection.
 */
export function buildNodeProbeEnv(parentEnv = process.env) {
  const env = { ...parentEnv };
  delete env.NODE_OPTIONS;
  return env;
}

/**
 * Collect exact `bun` / `node:<version>` markers from probe stdout, one token
 * per non-empty line. Mid-line chatter (deprecation banners, PID tags) is
 * ignored so a valid marker cannot be mistaken for noise or vice versa.
 *
 * @param {string} text
 * @returns {{ bun: boolean, nodeVersions: string[] }}
 */
export function collectProbeMarkers(text) {
  let bun = false;
  const nodeVersions = [];
  for (const rawLine of String(text ?? "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (EXACT_BUN_PROBE_LINE.test(line)) {
      bun = true;
      continue;
    }
    const nodeMatch = EXACT_NODE_PROBE_LINE.exec(line);
    if (nodeMatch) {
      nodeVersions.push(nodeMatch[1]);
    }
  }
  return { bun, nodeVersions };
}

/**
 * Bun 1.3.9 has known Linux segfault reports in long-running workloads.
 * Prefer Node by default for this one runtime/version combination.
 */
export function isKnownUnstableBunOnLinux({ platform, bunVersion }) {
  return (
    platform === "linux" &&
    typeof bunVersion === "string" &&
    KNOWN_UNSTABLE_BUN_LINUX.test(bunVersion)
  );
}

/**
 * Runtime selection priority:
 * 1) Explicit ELIZA_RUNTIME override (bun|node)
 * 2) Safety fallback for known unstable Bun/Linux combo when Node is available
 * 3) Default to an available runtime, preferring bun
 */
export function chooseElizaRuntime({
  requestedRuntime,
  platform,
  bunVersion,
  hasBun,
  hasNode,
}) {
  const normalized = requestedRuntime?.trim().toLowerCase();
  if (normalized === "bun" || normalized === "node") {
    return { runtime: normalized, warning: null };
  }

  if (
    hasNode !== false &&
    isKnownUnstableBunOnLinux({ platform, bunVersion })
  ) {
    return {
      runtime: "node",
      warning:
        "Detected Bun 1.3.9 on Linux (known segfault risk). Defaulting runtime to Node.js.",
    };
  }

  if (hasBun === false && hasNode) {
    return { runtime: "node", warning: null };
  }

  return { runtime: "bun", warning: null };
}

export function resolveNodeExecPath({
  currentExecPath,
  platform,
  explicitNodePath,
  probeNode = probeNodeExecutable,
}) {
  const explicit = explicitNodePath?.trim();
  if (explicit) {
    const validation = validateNodeExecutable({
      candidate: explicit,
      platform,
      probeNode,
    });
    if (!validation.ok) {
      throw new Error(
        `Invalid ELIZA_NODE_PATH=${explicit}: ${validation.reason}. Set ELIZA_NODE_PATH to a standard Node.js ${MIN_NODE_MAJOR}+ executable.`,
      );
    }
    return explicit;
  }

  const normalized =
    platform === "win32"
      ? (currentExecPath ?? "").toLowerCase()
      : (currentExecPath ?? "");
  const looksLikeBun = /(?:^|[\\/])bun(?:\.exe)?$/.test(normalized);

  if (!looksLikeBun && normalized.length > 0) {
    const validation = validateNodeExecutable({
      candidate: currentExecPath,
      platform,
      probeNode,
    });
    if (validation.ok) {
      return currentExecPath;
    }
  }

  const nodeCommand = platform === "win32" ? "node.exe" : "node";
  const validation = validateNodeExecutable({
    candidate: nodeCommand,
    platform,
    probeNode,
    allowMissingPath: true,
  });
  if (validation.ok) {
    return nodeCommand;
  }

  throw new Error(
    `No usable Node.js ${MIN_NODE_MAJOR}+ executable found (${validation.reason}). Install Node.js ${MIN_NODE_MAJOR}+ or set ELIZA_NODE_PATH=/absolute/path/to/node.`,
  );
}

function isCodexBundledNode(candidate, platform) {
  const normalized = (candidate ?? "").replace(/\\/g, "/");
  return (
    platform === "darwin" &&
    normalized.includes("/Applications/Codex.app/Contents/Resources/node")
  );
}

export function parseNodeMajor(version) {
  const major = /^(\d+)(?:\.|$)/.exec(version ?? "")?.[1];
  return major ? Number.parseInt(major, 10) : null;
}

export function validateNodeProbeOutput(output) {
  const text = output?.trim() ?? "";
  const { bun, nodeVersions } = collectProbeMarkers(text);

  // Bun detection stays priority: a shimmed Bun that also prints node-looking
  // chatter must still fail as Bun, not as a missing/ambiguous Node marker.
  if (bun) {
    return { ok: false, reason: "resolved to Bun, not Node.js" };
  }

  if (nodeVersions.length === 0) {
    return { ok: false, reason: "did not report a Node.js runtime" };
  }

  const uniqueVersions = [...new Set(nodeVersions)];
  if (uniqueVersions.length > 1) {
    return {
      ok: false,
      reason: `reported more than one Node.js runtime (${uniqueVersions.join(", ")})`,
    };
  }

  const version = uniqueVersions[0];
  const major = parseNodeMajor(version);
  if (major === null) {
    return { ok: false, reason: `could not parse Node.js version ${version}` };
  }
  if (major < MIN_NODE_MAJOR) {
    return {
      ok: false,
      reason: `Node.js ${version} is too old; Node.js ${MIN_NODE_MAJOR}+ is required`,
    };
  }
  return { ok: true, reason: null };
}

export function validateNodeExecutable({
  candidate,
  platform,
  probeNode = probeNodeExecutable,
  allowMissingPath = false,
}) {
  if (!candidate?.trim()) {
    return { ok: false, reason: "path is empty" };
  }
  if (isCodexBundledNode(candidate, platform)) {
    return { ok: false, reason: "Codex-bundled macOS Node is not supported" };
  }
  const probe = probeNode(candidate);
  if (probe.status !== 0) {
    if (allowMissingPath) {
      return {
        ok: false,
        reason: "node command was not found or failed to run",
      };
    }
    return {
      ok: false,
      reason:
        probe.stderr || probe.error || "executable failed the runtime probe",
    };
  }
  return validateNodeProbeOutput(probe.stdout);
}

export function probeNodeExecutable(candidate) {
  try {
    const result = spawnSync(
      candidate,
      [
        "-e",
        "process.stdout.write(process.versions.bun ? 'bun' : 'node:' + (process.versions.node || ''))",
      ],
      { encoding: "utf8", env: buildNodeProbeEnv() },
    );
    return {
      status: result.status ?? 1,
      stdout: result.stdout?.trim() ?? "",
      stderr: result.stderr?.trim() ?? "",
      error: result.error?.message,
    };
  } catch (error) {
    return {
      status: 1,
      stdout: "",
      stderr: "",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function resolveNodeExecPathFromCandidates({
  candidates,
  platform,
  explicitNodePath,
  probeNode = probeNodeExecutable,
}) {
  const explicit = explicitNodePath?.trim();
  if (explicit) {
    return resolveNodeExecPath({
      currentExecPath: explicit,
      platform,
      explicitNodePath: explicit,
      probeNode,
    });
  }

  let lastReason = "no candidates were provided";
  for (const candidate of candidates) {
    if (!candidate) continue;
    const validation = validateNodeExecutable({
      candidate,
      platform,
      probeNode,
    });
    if (validation.ok) {
      return candidate;
    }
    lastReason = `${candidate}: ${validation.reason}`;
  }

  throw new Error(
    `No usable Node.js ${MIN_NODE_MAJOR}+ executable found (${lastReason}). Install Node.js ${MIN_NODE_MAJOR}+ or set ELIZA_NODE_PATH=/absolute/path/to/node.`,
  );
}

export function getRequiredNodeMajor() {
  return MIN_NODE_MAJOR;
}

export function resolveRuntimeExecPath({
  runtime,
  currentExecPath,
  platform,
  explicitNodePath,
  bunPath,
}) {
  if (runtime === "bun") {
    return bunPath?.trim() || "bun";
  }
  return resolveNodeExecPath({
    currentExecPath,
    platform,
    explicitNodePath,
  });
}
