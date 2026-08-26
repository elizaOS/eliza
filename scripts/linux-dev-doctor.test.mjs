/** Tests deterministic Linux host inventory, pin enforcement, and secret-free output. */

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
    [
      "gh auth status --active --json hosts --jq .hosts | to_entries[] | .value[] | select(.active == true) | .login",
      "NubsCarson",
    ],
    ["git config user.name", "NubsCarson"],
    ["git config user.email", "nubs@nubs.site"],
    ["systemctl --user is-active pipewire", "active"],
    ["systemctl --user is-active wireplumber", "active"],
    ["systemctl is-active ssh", "active"],
    [
      "lspci -mm",
      '00:02.0 "VGA compatible controller" "Intel Corporation" "Arc Graphics"\n01:00.0 "3D controller" "NVIDIA Corporation" "RTX Fixture"',
    ],
    ["apt-get --version", "apt 3.0.3 (amd64)"],
    ["docker --version", "Docker version 28.0.0"],
    ["docker info --format {{.ServerVersion}}", "28.0.0"],
    ["podman --version", "podman version 5.4.0"],
    ["podman info --format {{.Version.Version}}", "5.4.0"],
    ["ufw status", "Status: active"],
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
      DESKTOP_SESSION: "gnome",
      GH_TOKEN: "ghp_never-print-this",
      XDG_CURRENT_DESKTOP: "GNOME",
      XDG_SESSION_TYPE: "wayland",
      WAYLAND_DISPLAY: "wayland-0",
      SECRET_TOKEN: "never-print-this",
    },
    exists: () => true,
    statfs: () => ({
      bavail: 12 * 1024 ** 2,
      bfree: 14 * 1024 ** 2,
      blocks: 32 * 1024 ** 2,
      bsize: 1024,
    }),
    readText: (target) =>
      target === "/proc/meminfo"
        ? [
            "MemTotal:       16777216 kB",
            "MemAvailable:    8388608 kB",
            "SwapTotal:       4194304 kB",
            "SwapFree:        2097152 kB",
            "",
          ].join("\n")
        : 'PRETTY_NAME="Fixture Linux"\n',
    readDir: () => ["video10", "video2", "video1"],
    kernelRelease: "6.12.0-fixture-amd64",
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
      result.findings.find(({ id }) => id === "kernel")?.detail,
      "6.12.0-fixture-amd64",
    );
    assert.equal(
      result.findings.find(({ id }) => id === "display-session")?.detail,
      "desktop GNOME; session wayland; display wayland-0",
    );
    assert.equal(
      result.findings.find(({ id }) => id === "memory")?.detail,
      "16.0 GiB total; 8.0 GiB available",
    );
    assert.equal(
      result.findings.find(({ id }) => id === "swap")?.detail,
      "4.0 GiB total; 2.0 GiB free",
    );
    assert.match(
      result.findings.find(({ id }) => id === "gpu")?.detail ?? "",
      /Intel Corporation Arc Graphics.*NVIDIA Corporation RTX Fixture/u,
    );
    assert.match(
      result.findings.find(({ id }) => id === "disk")?.detail ?? "",
      /12\.0 GiB available of 32\.0 GiB total \(56\.3% used\)/u,
    );
    assert.match(
      result.findings.find(({ id }) => id === "package-manager")?.detail ?? "",
      /^apt-get: apt 3\.0\.3/u,
    );
    assert.match(
      result.findings.find(({ id }) => id === "container:docker")?.detail ?? "",
      /daemon reachable/u,
    );
    assert.match(
      result.findings.find(({ id }) => id === "container:podman")?.detail ?? "",
      /daemonless engine usable/u,
    );
    assert.equal(
      result.findings.find(({ id }) => id === "firewall")?.detail,
      "ufw status: active",
    );
    assert.equal(
      result.findings.find(({ id }) => id === "github-auth")?.detail,
      "GitHub account NubsCarson",
    );
    assert.equal(
      result.findings.find(({ id }) => id === "camera-device")?.detail,
      "/dev/video1, /dev/video2, /dev/video10",
    );
    assert.doesNotMatch(JSON.stringify(result), /never-print-this/u);
    assert.doesNotMatch(JSON.stringify(result), /ghp_/u);
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

  it("reports unknown optional inventory without echoing command errors or auth material", () => {
    const calls = [];
    const unknown = report({
      run: (command, args) => {
        calls.push([command, ...args]);
        if (command === "bun" || command === "node") {
          return healthyRun(command, args);
        }
        if (command === "gh" && args[0] === "auth") {
          return {
            ok: false,
            status: 1,
            output:
              "authentication failed for ghp_must-not-leak with repo scope",
          };
        }
        if (command === "podman" && args[0] === "--version") {
          return { ok: true, status: 0, output: "podman version 5.4.0" };
        }
        if (
          command === "git" ||
          command === "c++" ||
          command === "cmake" ||
          command === "python3" ||
          command === "rustc" ||
          command === "cargo" ||
          command === "ssh" ||
          command === "ffmpeg" ||
          command === "Xvfb" ||
          command === "google-chrome" ||
          command === "pkg-config" ||
          command === "systemctl"
        ) {
          return healthyRun(command, args);
        }
        return {
          ok: false,
          status: 127,
          output: "permission denied: bearer secret-must-not-leak",
        };
      },
    });

    assert.equal(
      unknown.findings.find(({ id }) => id === "gpu")?.detail,
      "GPU summary unknown because lspci is unavailable or unreadable",
    );
    assert.equal(
      unknown.findings.find(({ id }) => id === "package-manager")?.detail,
      "No supported package manager was detected",
    );
    assert.match(
      unknown.findings.find(({ id }) => id === "container:podman")?.detail ??
        "",
      /engine unavailable or inaccessible/u,
    );
    assert.match(
      unknown.findings.find(({ id }) => id === "firewall")?.detail ?? "",
      /status unknown/u,
    );
    assert.equal(
      unknown.findings.find(({ id }) => id === "github-auth")?.detail,
      "GitHub account unavailable or unauthenticated",
    );
    assert.equal(
      calls.some(
        ([command, ...args]) =>
          command === "gh" &&
          args[0] === "auth" &&
          (!args.includes("--json") || !args.includes("--jq")),
      ),
      false,
    );
    assert.equal(
      calls.some(([command]) => command === "sudo"),
      false,
    );
    assert.doesNotMatch(
      JSON.stringify(unknown),
      /ghp_|repo scope|bearer|secret-must-not-leak/u,
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
