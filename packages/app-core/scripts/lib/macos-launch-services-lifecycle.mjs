/**
 * Owns the exact LaunchServices application started by the desktop dev host.
 * Authority binds canonical bundle path, PID, and launch timestamp so teardown
 * cannot target an installed copy, an older dev instance, or a reused PID.
 */

import { spawn } from "node:child_process";

// JXA has a cold-start cost that can exceed two seconds on a loaded macOS host.
// Keep the command bounded, but leave enough room for AppKit to initialize so
// shutdown does not abandon the exact app merely because osascript was cold.
const COMMAND_TIMEOUT_MS = 30_000;
const FORCE_DELAY_MS = 750;

function isValidApplicationIdentity(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isInteger(value.pid) &&
    value.pid > 0 &&
    Number.isFinite(value.launchTime)
  );
}

function authorityIsPresent(authority, applications) {
  return applications.some(
    (application) =>
      application.pid === authority.pid &&
      application.launchTime === authority.launchTime,
  );
}

function macApplicationSelectorScript(canonicalAppPath) {
  return `ObjC.import("AppKit");
const targetPath = ${JSON.stringify(canonicalAppPath)};
const targetName = ObjC.unwrap($(targetPath).lastPathComponent);
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
const matches = [];
for (let index = 0; index < Number(apps.count); index += 1) {
  const app = apps.objectAtIndex(index);
  const bundleURL = app.bundleURL;
  const bundlePath = bundleURL ? ObjC.unwrap(bundleURL.path) : null;
  if (typeof bundlePath !== "string") continue;
  // Canonicalization crosses the ObjC bridge and can be expensive on a loaded
  // host. A different bundle basename cannot resolve to the exact target path,
  // so reject it before asking Foundation to resolve symlinks.
  if (ObjC.unwrap($(bundlePath).lastPathComponent) !== targetName) continue;
  const canonicalBundlePath = ObjC.unwrap(
    $(bundlePath).stringByResolvingSymlinksInPath,
  );
  if (canonicalBundlePath !== targetPath) continue;
  const pid = Number(app.processIdentifier);
  const launchDate = app.launchDate;
  const launchTime = launchDate ? Number(launchDate.timeIntervalSince1970) : null;
  matches.push({ pid, launchTime });
}`;
}

/** Build a JXA query for all running apps at one canonical bundle path. */
export function buildMacApplicationInspectionScript(canonicalAppPath) {
  return `${macApplicationSelectorScript(canonicalAppPath)}
JSON.stringify(matches);`;
}

/** Build a JXA termination command bound to one previously claimed instance. */
export function buildMacApplicationTerminationScript(authority, force) {
  if (
    typeof authority?.canonicalAppPath !== "string" ||
    authority.canonicalAppPath.length === 0 ||
    !isValidApplicationIdentity(authority)
  ) {
    throw new TypeError("invalid macOS application authority");
  }
  const selector = force ? "forceTerminate" : "terminate";
  return `${macApplicationSelectorScript(authority.canonicalAppPath)}
let matched = 0;
for (const candidate of matches) {
  if (candidate.pid !== ${authority.pid} || candidate.launchTime !== ${authority.launchTime}) continue;
  for (let index = 0; index < Number(apps.count); index += 1) {
    const app = apps.objectAtIndex(index);
    if (Number(app.processIdentifier) === candidate.pid) {
      matched += 1;
      app.${selector};
    }
  }
}
JSON.stringify({ matched, force: ${force ? "true" : "false"} });`;
}

function runJxa(script, spawnCommand = spawn) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", script],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (error) {
      // error-policy:J1 Translate process-launch failure at the osascript boundary.
      resolve({ ok: false, stdout: "", error: String(error) });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ ok: false, stdout, error: "osascript timed out" });
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) =>
      finish({ ok: false, stdout, error: error.message }),
    );
    child.once("exit", (code) =>
      finish({
        ok: code === 0,
        stdout: stdout.trim(),
        error: code === 0 ? null : stderr.trim() || `osascript exited ${code}`,
      }),
    );
  });
}

/** Inspect running instances at a canonical bundle path. */
export async function inspectMacApplicationsAtPath(
  canonicalAppPath,
  spawnCommand = spawn,
) {
  const result = await runJxa(
    buildMacApplicationInspectionScript(canonicalAppPath),
    spawnCommand,
  );
  if (!result.ok) return { ok: false, applications: [], error: result.error };
  try {
    const parsed = JSON.parse(result.stdout);
    if (!Array.isArray(parsed))
      throw new Error("inspection result is not an array");
    if (!parsed.every(isValidApplicationIdentity)) {
      throw new Error("inspection result contains an invalid app identity");
    }
    const uniqueIdentities = new Set(
      parsed.map(({ pid, launchTime }) => `${pid}:${launchTime}`),
    );
    if (uniqueIdentities.size !== parsed.length) {
      throw new Error("inspection result contains duplicate app identities");
    }
    return { ok: true, applications: parsed, error: null };
  } catch (error) {
    // error-policy:J3 Reject malformed osascript output as invalid input.
    return { ok: false, applications: [], error: String(error) };
  }
}

/** Claim only one newly observed app instance after `open` returns. */
export async function claimMacApplicationAtPath(
  canonicalAppPath,
  baselineApplications,
  {
    spawnCommand = spawn,
    delay = setTimeout,
    attempts = 20,
    retryDelayMs = 100,
  } = {},
) {
  const baseline = new Set(
    baselineApplications.map(({ pid, launchTime }) => `${pid}:${launchTime}`),
  );
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const inspected = await inspectMacApplicationsAtPath(
      canonicalAppPath,
      spawnCommand,
    );
    if (!inspected.ok)
      return { ok: false, authority: null, error: inspected.error };
    const fresh = inspected.applications.filter(
      ({ pid, launchTime }) => !baseline.has(`${pid}:${launchTime}`),
    );
    if (fresh.length === 1) {
      return {
        ok: true,
        authority: { canonicalAppPath, ...fresh[0] },
        error: null,
      };
    }
    if (fresh.length > 1) {
      return {
        ok: false,
        authority: null,
        error: "ambiguous launched app instances",
      };
    }
    if (attempt + 1 < attempts) {
      await new Promise((resolve) => delay(resolve, retryDelayMs));
    }
  }
  return { ok: false, authority: null, error: "launched app was not observed" };
}

/** Run one bounded termination request for the exact claimed instance. */
export async function requestMacApplicationTermination(
  authority,
  force,
  spawnCommand = spawn,
) {
  let script;
  try {
    script = buildMacApplicationTerminationScript(authority, force);
  } catch (error) {
    // error-policy:J3 Reject malformed osascript output as invalid input.
    return { ok: false, matched: null, error: String(error) };
  }
  const result = await runJxa(script, spawnCommand);
  if (!result.ok) return { ok: false, matched: null, error: result.error };
  try {
    const parsed = JSON.parse(result.stdout);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      !Number.isInteger(parsed.matched) ||
      parsed.matched < 0 ||
      parsed.matched > 1 ||
      parsed.force !== force
    ) {
      throw new Error("invalid termination result");
    }
    return { ok: true, matched: parsed.matched, error: null };
  } catch (error) {
    return { ok: false, matched: null, error: String(error) };
  }
}

/** Ask the exact claimed app to quit, then force only that same instance. */
export async function stopMacApplication(
  authority,
  { spawnCommand = spawn, delay = setTimeout } = {},
) {
  const graceful = await requestMacApplicationTermination(
    authority,
    false,
    spawnCommand,
  );
  await new Promise((resolve) => delay(resolve, FORCE_DELAY_MS));
  const afterGrace = await inspectMacApplicationsAtPath(
    authority.canonicalAppPath,
    spawnCommand,
  );
  if (!afterGrace.ok) {
    return {
      graceful,
      forced: { ok: false, matched: null, error: afterGrace.error },
    };
  }
  if (!authorityIsPresent(authority, afterGrace.applications)) {
    return {
      graceful,
      forced: { ok: true, matched: 0, error: null },
    };
  }
  const forced = await requestMacApplicationTermination(
    authority,
    true,
    spawnCommand,
  );
  if (!forced.ok) return { graceful, forced };
  if (forced.matched !== 1) {
    return {
      graceful,
      forced: {
        ok: false,
        matched: forced.matched,
        error: "exact app disappeared before forceTerminate matched it",
      },
    };
  }
  await new Promise((resolve) => delay(resolve, FORCE_DELAY_MS));
  const afterForce = await inspectMacApplicationsAtPath(
    authority.canonicalAppPath,
    spawnCommand,
  );
  if (!afterForce.ok) {
    return {
      graceful,
      forced: { ok: false, matched: forced.matched, error: afterForce.error },
    };
  }
  if (authorityIsPresent(authority, afterForce.applications)) {
    return {
      graceful,
      forced: {
        ok: false,
        matched: forced.matched,
        error: "exact app remained after forceTerminate",
      },
    };
  }
  return { graceful, forced };
}
