/** Bounded, serial-bound health probe for the port-free Android runtime. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { androidSocketFetch } from "../aosp/lib/android-socket-fetch.ts";

const script = fileURLToPath(import.meta.url);

// Keep the installer synchronous; the child owns the short-lived ADB forward.
// Only stdin carries the bearer. Never expose child stderr on failure.
export function readAndroidHealth(adb, serial, token) {
  const result = spawnSync(process.execPath, [script, adb, serial], {
    input: token,
    encoding: "utf8",
    timeout: 25000,
    maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error("authenticated agent health transport failed");
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("invalid agent health transport response");
  }
}

export async function probeAndroidHealth(
  adb,
  serial,
  token,
  run,
  fetchHealth = androidSocketFetch,
) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(serial) ||
    !/^[A-Za-z0-9._~+/-]{1,4096}={0,2}$/.test(token)
  )
    throw new Error("invalid health probe identity or credential");
  const port = run(adb, [
    "-s",
    serial,
    "forward",
    "tcp:0",
    "localabstract:eliza_local_agent_v1",
  ]).trim();
  if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65535)
    throw new Error("invalid ADB forward port");
  try {
    const response = await fetchHealth(`http://127.0.0.1:${port}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(5000),
    });
    return { status: response.status, body: await response.text() };
  } finally {
    run(adb, ["-s", serial, "forward", "--remove", `tcp:${port}`]);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === script) {
  try {
    const result = await probeAndroidHealth(
      process.argv[2],
      process.argv[3],
      fs.readFileSync(0, "utf8").trim(),
      (command, args) => {
        const child = spawnSync(command, args, {
          encoding: "utf8",
          timeout: 5000,
        });
        if (child.error || child.status !== 0)
          throw new Error("ADB forward failed");
        return child.stdout;
      },
    );
    process.stdout.write(JSON.stringify(result));
  } catch {
    process.stderr.write("authenticated agent health transport failed\n");
    process.exitCode = 1;
  }
}
