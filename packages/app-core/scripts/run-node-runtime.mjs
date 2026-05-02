const KNOWN_UNSTABLE_BUN_LINUX = /^1\.3\.9(?:$|[-+].*)/;

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
 * 2) Safety fallback for known unstable Bun/Linux combo
 * 3) Default to bun
 */
export function chooseElizaRuntime({ requestedRuntime, platform, bunVersion }) {
  const normalized = requestedRuntime?.trim().toLowerCase();
  if (normalized === "bun" || normalized === "node") {
    return { runtime: normalized, warning: null };
  }

  if (isKnownUnstableBunOnLinux({ platform, bunVersion })) {
    return {
      runtime: "node",
      warning:
        "Detected Bun 1.3.9 on Linux (known segfault risk). Defaulting runtime to Node.js.",
    };
  }

  return { runtime: "bun", warning: null };
}

export function resolveNodeExecPath({
  currentExecPath,
  platform,
  explicitNodePath,
}) {
  const explicit = explicitNodePath?.trim();
  if (explicit) {
    return explicit;
  }

  const normalized =
    platform === "win32"
      ? (currentExecPath ?? "").toLowerCase()
      : (currentExecPath ?? "");
  const looksLikeBun = /(?:^|[\\/])bun(?:\.exe)?$/.test(normalized);

  if (!looksLikeBun && normalized.length > 0) {
    return currentExecPath;
  }

  return platform === "win32" ? "node.exe" : "node";
}

export function resolveRuntimeExecPath({
  runtime,
  currentExecPath,
  platform,
  explicitNodePath,
}) {
  if (runtime === "bun") {
    return "bun";
  }
  return resolveNodeExecPath({
    currentExecPath,
    platform,
    explicitNodePath,
  });
}
