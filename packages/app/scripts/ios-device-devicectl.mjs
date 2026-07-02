/**
 * Impure devicectl edge shared by the ios-device-* scripts.
 *
 * Kept out of ios-device-lib.mjs on purpose — everything exported from the
 * lib is deterministic and side-effect free so it can be unit-tested; this
 * module owns the one devicectl subprocess call the scripts share.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Run `xcrun devicectl list devices` and return the parsed JSON payload.
 *
 * devicectl writes its JSON with atomic-save file semantics, so
 * `--json-output /dev/stdout` fails on pipes with NSCocoaErrorDomain 512
 * ("The file 'stdout' couldn't be saved in the folder 'dev'") — the output
 * must go to a real file.
 *
 * @returns {{ result?: { devices?: Array<Record<string, unknown>> } }}
 */
export function readDevicectlDeviceList() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eliza-devicectl-"));
  const jsonPath = path.join(tmpDir, "devices.json");
  try {
    execFileSync(
      "xcrun",
      ["devicectl", "list", "devices", "--json-output", jsonPath, "--quiet"],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    return JSON.parse(fs.readFileSync(jsonPath, "utf8"));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
