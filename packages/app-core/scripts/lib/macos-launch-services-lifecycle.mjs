/**
 * Owns the exact LaunchServices application started by the desktop dev host.
 * Matching is by canonical bundle path, never process name or bundle id, so an
 * installed copy of the same branded app cannot be terminated accidentally.
 */

import { spawn } from "node:child_process";

const COMMAND_TIMEOUT_MS = 2_000;
const FORCE_DELAY_MS = 750;

/** Build a JXA command that targets only a running app at `canonicalAppPath`. */
export function buildMacApplicationTerminationScript(canonicalAppPath, force) {
  const target = JSON.stringify(canonicalAppPath);
  const selector = force ? "forceTerminate" : "terminate";
  return `ObjC.import("AppKit");
const target = ${target};
const apps = $.NSWorkspace.sharedWorkspace.runningApplications;
let matched = 0;
for (let index = 0; index < Number(apps.count); index += 1) {
  const app = apps.objectAtIndex(index);
  const bundleURL = app.bundleURL;
  const bundlePath = bundleURL ? ObjC.unwrap(bundleURL.path) : null;
  if (typeof bundlePath !== "string") continue;
  const canonicalBundlePath = ObjC.unwrap(
    $(bundlePath).stringByResolvingSymlinksInPath,
  );
  if (canonicalBundlePath === target) {
    matched += 1;
    app.${selector};
  }
}
JSON.stringify({ matched, force: ${force ? "true" : "false"} });`;
}

/** Run one bounded exact-path termination request through macOS JXA. */
export function requestMacApplicationTermination(
  canonicalAppPath,
  force,
  spawnCommand = spawn,
) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCommand(
        "/usr/bin/osascript",
        [
          "-l",
          "JavaScript",
          "-e",
          buildMacApplicationTerminationScript(canonicalAppPath, force),
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
    } catch (error) {
      // error-policy:J1 The supervisor boundary converts a failed helper spawn
      // into an observable shutdown result instead of abandoning sibling drain.
      resolve({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    let stderr = "";
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
      finish({ ok: false, error: "osascript timed out" });
    }, COMMAND_TIMEOUT_MS);
    child.once("error", (error) => finish({ ok: false, error: error.message }));
    child.once("exit", (code) =>
      finish({
        ok: code === 0,
        error: code === 0 ? null : stderr.trim() || `osascript exited ${code}`,
      }),
    );
  });
}

/** Ask the exact app to quit, then force only that same path if it remains. */
export async function stopMacApplicationAtPath(
  canonicalAppPath,
  { spawnCommand = spawn, delay = setTimeout } = {},
) {
  const graceful = await requestMacApplicationTermination(
    canonicalAppPath,
    false,
    spawnCommand,
  );
  await new Promise((resolve) => delay(resolve, FORCE_DELAY_MS));
  const forced = await requestMacApplicationTermination(
    canonicalAppPath,
    true,
    spawnCommand,
  );
  return { graceful, forced };
}
