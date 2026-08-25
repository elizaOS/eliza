/** Tests Linux doctor classification, pin enforcement, and secret-free output. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  collectLinuxDevReport,
  parseLinuxDoctorArgs,
  renderLinuxDevReport,
} from "./linux-dev-doctor.mjs";

function healthyRun(command, args) {
  const key = `${command} ${args.join(" ")}`;
  const outputs = new Map([
    ["bun --version", "1.3.14"],
    ["node --version", "v24.15.0"],
    ["git config user.name", "NubsCarson"],
    ["git config user.email", "nubs@nubs.site"],
    ["systemctl --user is-active pipewire", "active"],
    ["systemctl --user is-active wireplumber", "active"],
    ["systemctl is-active ssh", "active"],
    ["systemctl is-active docker", "active"],
    ["google-chrome --version", "Google Chrome 151"],
  ]);
  if (outputs.has(key))
    return { ok: true, status: 0, output: outputs.get(key) };
  if (command === "pkg-config") return { ok: true, status: 0, output: "1.0" };
  if (
    [
      "git",
      "gh",
      "c++",
      "cmake",
      "python3",
      "rustc",
      "cargo",
      "ssh",
      "ffmpeg",
      "Xvfb",
    ].includes(command)
  ) {
    return { ok: true, status: 0, output: `${command} fixture` };
  }
  return { ok: false, status: 127, output: "" };
}

function report(overrides = {}) {
  return collectLinuxDevReport({
    run: healthyRun,
    platform: "linux",
    arch: "x64",
    env: {
      WAYLAND_DISPLAY: "wayland-0",
      SECRET_TOKEN: "never-print-this",
    },
    exists: () => true,
    statfs: () => ({ bavail: 12 * 1024 ** 2, bsize: 1024 }),
    readText: () => 'PRETTY_NAME="Fixture Linux"\n',
    readDir: () => ["video0", "video1"],
    ...overrides,
  });
}

describe("Linux development doctor", () => {
  it("accepts the exact repository toolchain and required Linux capabilities", () => {
    const result = report();
    assert.equal(result.summary.failed, 0);
    assert.equal(result.findings.find(({ id }) => id === "bun")?.ok, true);
    assert.equal(result.findings.find(({ id }) => id === "node")?.ok, true);
    assert.equal(
      result.findings.find(({ id }) => id === "camera-device")?.detail,
      "/dev/video0, /dev/video1",
    );
    assert.doesNotMatch(JSON.stringify(result), /never-print-this/u);
  });

  it("fails strict prerequisites on pin, package, and disk drift while preserving fixes", () => {
    const drifted = report({
      run: (command, args) => {
        if (command === "bun") return { ok: true, status: 0, output: "1.4.0" };
        if (command === "pkg-config" && args[1] === "webkit2gtk-4.1") {
          return { ok: false, status: 1, output: "" };
        }
        return healthyRun(command, args);
      },
      statfs: () => ({ bavail: 2 * 1024 ** 2, bsize: 1024 }),
    });
    assert.deepEqual(
      drifted.findings
        .filter(({ required, ok }) => required && !ok)
        .map(({ id }) => id),
      ["bun", "pkg:webkit2gtk-4.1", "disk"],
    );
    assert.match(
      renderLinuxDevReport(drifted),
      /sudo apt install libwebkit2gtk-4\.1-dev/u,
    );
  });

  it("parses normalized output flags and rejects typoed arguments", () => {
    assert.deepEqual(parseLinuxDoctorArgs(["--json", "--strict"]), {
      json: true,
      strict: true,
    });
    assert.throws(
      () => parseLinuxDoctorArgs(["--strcit"]),
      /unknown argument/u,
    );
  });
});
