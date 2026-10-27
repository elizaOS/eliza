#!/usr/bin/env node
/**
 * Read-only post-boot checks of a launcher image built with the common
 * least-privilege profile (Cuttlefish or Pixel 10a): the exact image, a nonprivileged
 * system launcher with the staged bytes as HOME, a remaining system recovery HOME,
 * the system Clock's alarm handlers, a WebView provider and, when staged, the
 * narrowly privileged Sense listener. No install, role change, alarm or runtime
 * request is made. A pass is image evidence for these facts only.
 *
 *   node verify-launcher-image.mjs --target cuttlefish|pixel10a --serial SERIAL --user N
 *     --descriptor LAUNCHER_JSON --fingerprint EXACT --apk-path /product/app/M/M.apk
 *     --out NEW_REPORT [--listener] [--adb PATH]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyAospClockHandlers } from "./aosp-clock-handlers.mjs";
import { verifyAospListener } from "./sense-listener.mjs";

const PACKAGE = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$/;
const requireThat = (value, message) => {
  if (!value) throw Error(message);
};

/** Image targets this check admits and the adb serials that may name them. */
export const LAUNCHER_IMAGE_TARGETS = Object.freeze({
  cuttlefish: {
    admits: ({ hardware, device }) =>
      ["cutf_cvm", "cutf_ivshmem", "cutf_vm"].includes(hardware) &&
      /^vsoc_/.test(device),
    refusal: "Only Cuttlefish is admitted",
    serial: /^(127\.0\.0\.1|localhost):\d{2,5}$/,
    serialMessage: "Explicit loopback Cuttlefish endpoint required",
  },
  pixel10a: {
    admits: ({ device }) => device === "stallion",
    refusal: "Only Pixel 10a (stallion) is admitted",
    serial: /^[A-Za-z0-9]{6,32}$/,
    serialMessage: "Explicit Pixel 10a USB serial required",
  },
});

const component = (value) => value.replace("/.", `/${value.split("/")[0]}.`);
const components = (text) =>
  text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[A-Za-z][\w.]*\/[.A-Za-z][\w.$]*$/.test(line))
    .map(component);

export function validateExpectation(expected) {
  requireThat(
    PACKAGE.test(expected?.packageName ?? ""),
    "Expected launcher package required",
  );
  requireThat(
    /^[a-f0-9]{64}$/.test(expected.apkSha256 ?? ""),
    "Expected APK SHA-256 required",
  );
  requireThat(
    /^[a-f0-9]{64}$/.test(expected.certificateSha256 ?? ""),
    "Expected certificate SHA-256 required",
  );
  requireThat(
    typeof expected.fingerprint === "string" &&
      expected.fingerprint.length > 0 &&
      expected.fingerprint.length <= 512 &&
      !/[\r\n\0]/.test(expected.fingerprint),
    "Exact expected image fingerprint required",
  );
  requireThat(
    /^\/(product|system|system_ext)\/app\/[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+\.apk$/.test(
      expected.apkPath ?? "",
    ) && !expected.apkPath.split("/").includes(".."),
    "Expected nonprivileged system APK path required",
  );
  requireThat(
    expected.homeActivity === undefined ||
      /^[A-Za-z][\w.$]*$/.test(expected.homeActivity),
    "Expected HOME activity must be a class name",
  );
  return expected;
}

/** Injected runner enables controlled negative tests; all commands are read-only. */
export function verifyLauncherImage(
  run,
  expected,
  user,
  target = "cuttlefish",
) {
  const image = LAUNCHER_IMAGE_TARGETS[target];
  requireThat(image, `Unknown launcher image target ${target}`);
  validateExpectation(expected);
  requireThat(
    /^(0|[1-9]\d*)$/.test(user ?? ""),
    "Explicit Android user required",
  );
  const pkg = expected.packageName;
  const shell = (...args) => run("shell", ...args).trim();
  const prop = (name) => shell("getprop", name);
  requireThat(prop("sys.boot_completed") === "1", "Android boot is incomplete");
  const hardware = prop("ro.hardware"),
    device = prop("ro.product.device");
  requireThat(image.admits({ hardware, device }), image.refusal);
  const verifiedBoot =
    target === "pixel10a"
      ? {
          state: prop("ro.boot.verifiedbootstate"),
          slotSuffix: prop("ro.boot.slot_suffix"),
        }
      : null;
  const fingerprint = prop("ro.build.fingerprint");
  requireThat(
    fingerprint === expected.fingerprint,
    "Booted image fingerprint differs from expectation",
  );
  const bootId = shell("cat", "/proc/sys/kernel/random/boot_id");
  requireThat(/^[a-f0-9-]{36}$/.test(bootId), "Boot identity unavailable");
  requireThat(
    shell("am", "get-current-user") === user,
    "Selected user is not foreground",
  );
  requireThat(
    shell("am", "get-started-user-state", user) === "RUNNING_UNLOCKED",
    "Selected user is not in RUNNING_UNLOCKED state",
  );
  requireThat(shell("getenforce") === "Enforcing", "SELinux is not enforcing");
  const installedPath = () => shell("pm", "path", "--user", user, pkg);
  requireThat(
    installedPath() === `package:${expected.apkPath}`,
    "The launcher is missing, split, or overridden by a data APK",
  );
  const digest = () => {
    const result = shell("sha256sum", expected.apkPath);
    requireThat(
      /^[a-f0-9]{64}\s/.test(result),
      "Installed APK digest unavailable",
    );
    return result.split(/\s+/)[0];
  };
  requireThat(
    digest() === expected.apkSha256,
    "Installed APK differs from the staged launcher",
  );
  const homeArgs = [
    "--user",
    user,
    "-a",
    "android.intent.action.MAIN",
    "-c",
    "android.intent.category.HOME",
  ];
  const homeActivity = `${pkg}/${expected.homeActivity ?? `${pkg}.MainActivity`}`;
  const home = components(
    shell("cmd", "package", "resolve-activity", "--brief", ...homeArgs),
  );
  requireThat(
    home.length === 1 && home[0] === homeActivity,
    "The launcher is not the resolved HOME",
  );
  const candidates = components(
    shell(
      "cmd",
      "package",
      "query-activities",
      "--brief",
      "--components",
      ...homeArgs,
    ),
  );
  // Settings FallbackHome only waits for a real HOME; it is not a recovery launcher.
  const recovery = [
    ...new Set(
      candidates.filter(
        (row) =>
          !row.startsWith(`${pkg}/`) &&
          row !== "com.android.settings/com.android.settings.FallbackHome",
      ),
    ),
  ].filter((row) => {
    const owner = row.split("/")[0];
    return shell("pm", "list", "packages", "--user", user, "-s", "-e", owner)
      .split(/\r?\n/)
      .includes(`package:${owner}`);
  });
  requireThat(recovery.length > 0, "No enabled system recovery HOME remains");
  const clock = verifyAospClockHandlers(run, user, expected.fingerprint);
  const webview =
    /Current WebView package \(name, version\):\s*\(([^,\s]+),\s*([^)]+)\)/.exec(
      shell("dumpsys", "webviewupdate"),
    );
  requireThat(webview, "Current WebView provider unavailable");
  const listener =
    expected.listener === true ? verifyAospListener(run, user, pkg) : null;
  // Re-observe mutable provisioning state; RUNNING_UNLOCKED is a user lifecycle state,
  // not evidence that the keyguard is currently dismissed. These are sequential observations.
  const finalHome = components(
    shell("cmd", "package", "resolve-activity", "--brief", ...homeArgs),
  );
  requireThat(
    finalHome.length === 1 &&
      finalHome[0] === home[0] &&
      shell("getenforce") === "Enforcing" &&
      shell("am", "get-started-user-state", user) === "RUNNING_UNLOCKED",
    "HOME, SELinux or user running state changed during verification",
  );
  // Reject a result assembled across a reboot, foreground-user change or APK replacement.
  requireThat(
    shell("cat", "/proc/sys/kernel/random/boot_id") === bootId &&
      prop("sys.boot_completed") === "1" &&
      prop("ro.build.fingerprint") === fingerprint &&
      shell("am", "get-current-user") === user &&
      installedPath() === `package:${expected.apkPath}` &&
      digest() === expected.apkSha256,
    "Image, user or APK changed during verification",
  );
  return {
    passed: true,
    evidence: `${target}-launcher-postboot`,
    fingerprint,
    hardware,
    device,
    user,
    verifiedBoot,
    apkPath: expected.apkPath,
    apkSha256: expected.apkSha256,
    certificateSha256: expected.certificateSha256,
    certificateEvidence: "same APK bytes as supplied staging descriptor",
    home: home[0],
    recoveryHomes: recovery,
    clock,
    webview: { packageName: webview[1], version: webview[2] },
    listener,
    runtimeExecutionVerified: false,
    physicalDeviceVerified: false,
    productionReleaseVerified: false,
    scope:
      "Booted image fingerprint, exact system launcher bytes, HOME, recovery HOME, Clock handlers, WebView presence and the staged listener's privileges only",
  };
}

export function parseArgs(args, target = null) {
  const values = {};
  const allowed = [
    "--target",
    "--serial",
    "--user",
    "--descriptor",
    "--fingerprint",
    "--apk-path",
    "--out",
    "--adb",
  ];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--listener") {
      requireThat(!values[flag], "Invalid or duplicate option: --listener");
      values[flag] = true;
      continue;
    }
    requireThat(
      allowed.includes(flag) &&
        values[flag] === undefined &&
        args[i + 1] &&
        !args[i + 1].startsWith("--"),
      `Invalid or duplicate option: ${flag}`,
    );
    values[flag] = args[++i];
  }
  if (target) {
    requireThat(
      !values["--target"] || values["--target"] === target,
      `Only --target ${target} is admitted`,
    );
    values["--target"] = target;
  }
  for (const flag of allowed.filter((flag) => flag !== "--adb"))
    requireThat(values[flag], `${flag} required`);
  const image = LAUNCHER_IMAGE_TARGETS[values["--target"]];
  requireThat(image, "--target must be cuttlefish or pixel10a");
  requireThat(image.serial.test(values["--serial"]), image.serialMessage);
  return values;
}

/** CLI; a brand wrapper may fix the target and check the descriptor's identity. */
export function main(
  argv = process.argv.slice(2),
  { target = null, admitDescriptor = (value) => value } = {},
) {
  let options, output;
  try {
    options = parseArgs(argv, target);
    // Reserve a new report before reading device state; never overwrite previous evidence.
    output = fs.openSync(options["--out"], "wx", 0o600);
    const descriptorBytes = fs.readFileSync(options["--descriptor"]);
    const expected = admitDescriptor({
      ...JSON.parse(descriptorBytes),
      fingerprint: options["--fingerprint"],
      apkPath: options["--apk-path"],
      ...(options["--listener"] ? { listener: true } : {}),
    });
    const run = (...args) => {
      try {
        return execFileSync(
          options["--adb"] ?? "adb",
          ["-s", options["--serial"], ...args],
          {
            encoding: "utf8",
            timeout: 15_000,
            maxBuffer: 1024 * 1024,
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
      } catch {
        throw Error("ADB observation failed or timed out");
      }
    };
    const report = verifyLauncherImage(
      run,
      expected,
      options["--user"],
      options["--target"],
    );
    report.descriptorSha256 = createHash("sha256")
      .update(descriptorBytes)
      .digest("hex");
    report.observedAt = new Date().toISOString();
    fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`PASS ${options["--out"]}: ${report.evidence} checks only`);
  } catch (error) {
    // Subprocess errors can contain stdout/stderr; retain a bounded diagnostic, not raw device dumps.
    const message = String(error.message).slice(0, 1024);
    if (output !== undefined)
      fs.writeFileSync(
        output,
        `${JSON.stringify({ passed: false, evidence: `${options?.["--target"] ?? "launcher"}-launcher-postboot`, error: message, observedAt: new Date().toISOString() }, null, 2)}\n`,
      );
    console.error(message);
    process.exitCode = 1;
  } finally {
    if (output !== undefined) fs.closeSync(output);
  }
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
