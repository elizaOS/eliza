// Read-only post-boot launcher image checks against a scripted adb. These establish the
// observations and refusals, never an image boot, a device or a release.
import assert from "node:assert/strict";
import test from "node:test";
import {
  parseArgs,
  validateExpectation,
  verifiedBootProblem,
  verifyLauncherImage,
} from "../android/verify-launcher-image.mjs";

const pkg = "ai.elizaos.app";
const expected = {
  packageName: pkg,
  apkSha256: "a".repeat(64),
  certificateSha256: "b".repeat(64),
  fingerprint: "elizaOS/eliza_cf/vsoc_x86_64_only:17/test:userdebug/test-keys",
  apkPath: "/product/app/Eliza/Eliza.apk",
};
const pixel = {
  ...expected,
  fingerprint:
    "elizaOS/eliza_stallion_phone/stallion:17/CP2A.261005.001/1:user/release-keys",
};
const HOME_QUERY =
  "shell cmd package query-activities --brief --components --user 0 -a android.intent.action.MAIN -c android.intent.category.HOME";
const HOME_RESOLVE =
  "shell cmd package resolve-activity --brief --user 0 -a android.intent.action.MAIN -c android.intent.category.HOME";
const WRITES = ["install", "uninstall", "start", "set", "grant", "reboot"];

function fixture(overrides = {}, image = expected, target = "cuttlefish") {
  const calls = [];
  let hashes = 0;
  const run = (...args) => {
    calls.push(args);
    const s = args.join(" ");
    if (overrides[s] !== undefined)
      return typeof overrides[s] === "function" ? overrides[s]() : overrides[s];
    if (s === "shell getprop sys.boot_completed") return "1";
    if (s === "shell getprop ro.hardware")
      return target === "pixel10a" ? "stallion" : "cutf_cvm";
    if (s === "shell getprop ro.product.device")
      return target === "pixel10a" ? "stallion" : "vsoc_x86_64_only";
    if (s === "shell getprop ro.boot.verifiedbootstate") return "green";
    if (s === "shell getprop ro.boot.slot_suffix") return "_a";
    if (s === "shell getprop ro.build.fingerprint") return image.fingerprint;
    if (s === "shell cat /proc/sys/kernel/random/boot_id")
      return "12345678-1234-1234-1234-123456789abc";
    if (s === "shell am get-current-user") return "0";
    if (s === "shell am get-started-user-state 0") return "RUNNING_UNLOCKED";
    if (s === "shell getenforce") return "Enforcing";
    if (s === `shell pm path --user 0 ${pkg}`)
      return `package:${image.apkPath}`;
    if (s === `shell sha256sum ${image.apkPath}`) {
      hashes++;
      return `${image.apkSha256}  ${image.apkPath}`;
    }
    if (s === HOME_RESOLVE) return `${pkg}/.MainActivity`;
    if (s === HOME_QUERY)
      return `${pkg}/.MainActivity\ncom.android.launcher3/.Launcher`;
    if (s.includes("pm list packages") && s.endsWith("com.android.launcher3"))
      return "package:com.android.launcher3";
    if (s.includes("pm list packages") && s.endsWith("com.android.deskclock"))
      return "package:com.android.deskclock";
    if (s.includes("query-activities") && s.endsWith("com.android.deskclock"))
      return "com.android.deskclock/.HandleApiCalls";
    if (s === "shell dumpsys webviewupdate")
      return "Current WebView package (name, version): (com.android.webview, 145.0.1)";
    if (s.includes("pm list packages") && s.endsWith(`${pkg}.sense`))
      return `package:${pkg}.sense`;
    if (s === `shell dumpsys package ${pkg}.sense`)
      return "privateFlags=[ PRIVILEGED ]\nflags=[ SYSTEM PERSISTENT ]\nandroid.permission.CAPTURE_AUDIO_HOTWORD: granted=true\nandroid.permission.RECORD_AUDIO: granted=true";
    if (s === `shell dumpsys package ${pkg}`) return "privateFlags=[ ]";
    if (s === "shell getprop ro.hotword.detection_service_required")
      return "true";
    if (s === "shell device_config get privacy camera_mic_icons_enabled")
      return "null";
    if (s.startsWith("shell cmd role get-role-holders")) return "";
    if (s === `shell dumpsys activity services ${pkg}.sense`)
      return "ServiceRecord ai.elizaos.app.sense/.ListeningService";
    throw Error(`Unexpected command ${s}`);
  };
  return { run, calls, hashes: () => hashes };
}
const readOnly = (calls) =>
  calls.every(
    (args) =>
      args[0] === "shell" && !args.some((value) => WRITES.includes(value)),
  );

test("Cuttlefish image and system launcher checks remain read-only and narrowly scoped", () => {
  const f = fixture();
  const report = verifyLauncherImage(f.run, expected, "0", "cuttlefish");
  assert.equal(report.passed, true);
  assert.equal(report.evidence, "cuttlefish-launcher-postboot");
  assert.equal(f.hashes(), 2);
  assert.deepEqual(report.recoveryHomes, [
    "com.android.launcher3/com.android.launcher3.Launcher",
  ]);
  assert.equal(report.clock.ringingVerified, false);
  assert.equal(report.listener, null);
  assert.equal(report.physicalDeviceVerified, false);
  assert.ok(readOnly(f.calls));
});

test("the Pixel 10a target admits only stallion and records its verified boot state and listener", () => {
  const f = fixture({}, { ...pixel, listener: true }, "pixel10a");
  const report = verifyLauncherImage(
    f.run,
    { ...pixel, listener: true },
    "0",
    "pixel10a",
  );
  assert.equal(report.evidence, "pixel10a-launcher-postboot");
  assert.deepEqual(report.verifiedBoot, { state: "green", slotSuffix: "_a" });
  assert.equal(report.listener.privileged, true);
  assert.equal(report.listener.indicatorVerified, false);
  assert.ok(readOnly(f.calls));
  assert.throws(
    () =>
      verifyLauncherImage(
        fixture({}, pixel, "cuttlefish").run,
        pixel,
        "0",
        "pixel10a",
      ),
    /Only Pixel 10a/,
  );
  assert.throws(
    () =>
      verifyLauncherImage(
        fixture(
          { [`shell dumpsys package ${pkg}`]: "privateFlags=[ PRIVILEGED ]" },
          pixel,
          "pixel10a",
        ).run,
        { ...pixel, listener: true },
        "0",
        "pixel10a",
      ),
    /must stay nonprivileged/,
  );
});

test("the Pixel 10a target refuses an unlocked or failed verified boot state", () => {
  for (const state of ["green", "yellow"])
    assert.equal(
      verifyLauncherImage(
        fixture(
          { "shell getprop ro.boot.verifiedbootstate": state },
          pixel,
          "pixel10a",
        ).run,
        pixel,
        "0",
        "pixel10a",
      ).verifiedBoot.state,
      state,
    );
  for (const state of ["orange", "red", ""])
    assert.throws(
      () =>
        verifyLauncherImage(
          fixture(
            { "shell getprop ro.boot.verifiedbootstate": state },
            pixel,
            "pixel10a",
          ).run,
          pixel,
          "0",
          "pixel10a",
        ),
      /is not green or yellow; the bootloader must be locked/,
    );
  assert.equal(verifiedBootProblem("cuttlefish", "orange"), null);
  assert.match(verifiedBootProblem("pixel10a", undefined), /null is not green/);
});

for (const [name, key, value] of [
  ["wrong image", "shell getprop ro.build.fingerprint", "different"],
  [
    "physical hardware on the virtual target",
    "shell getprop ro.hardware",
    "tensor",
  ],
  ["locked user", "shell am get-started-user-state 0", "false"],
  ["wrong foreground", "shell am get-current-user", "10"],
  ["permissive SELinux", "shell getenforce", "Permissive"],
  [
    "updated data APK",
    `shell pm path --user 0 ${pkg}`,
    "package:/data/app/Eliza/base.apk",
  ],
  [
    "different APK",
    `shell sha256sum ${expected.apkPath}`,
    `${"c".repeat(64)}  ${expected.apkPath}`,
  ],
  [
    "missing Clock",
    "shell pm list packages --user 0 -s -e com.android.deskclock",
    "",
  ],
  [
    "missing WebView",
    "shell dumpsys webviewupdate",
    "Current WebView package is null",
  ],
  [
    "unavailable recovery",
    "shell pm list packages --user 0 -s -e com.android.launcher3",
    "",
  ],
  [
    "Settings FallbackHome as the only other HOME",
    HOME_QUERY,
    `${pkg}/.MainActivity\ncom.android.settings/.FallbackHome`,
  ],
])
  test(`rejects ${name}`, () =>
    assert.throws(() =>
      verifyLauncherImage(
        fixture({ [key]: value }).run,
        expected,
        "0",
        "cuttlefish",
      ),
    ));

test("rejects a reboot or a HOME change during observation", () => {
  let reads = 0;
  const reboot = fixture({
    "shell cat /proc/sys/kernel/random/boot_id": () =>
      ++reads === 1
        ? "12345678-1234-1234-1234-123456789abc"
        : "22345678-1234-1234-1234-123456789abc",
  });
  assert.throws(
    () => verifyLauncherImage(reboot.run, expected, "0"),
    /changed during/,
  );
  let transitioned = false;
  const home = fixture({
    [HOME_RESOLVE]: () =>
      transitioned ? "com.android.launcher3/.Launcher" : `${pkg}/.MainActivity`,
    "shell dumpsys webviewupdate": () => {
      transitioned = true;
      return "Current WebView package (name, version): (com.android.webview, 145.0.1)";
    },
  });
  assert.throws(
    () => verifyLauncherImage(home.run, expected, "0"),
    /^Error: HOME, SELinux or user running state changed during verification$/,
  );
});

test("expectations and options are explicit, bounded and nonprivileged", () => {
  assert.throws(() =>
    validateExpectation({ ...expected, apkPath: "/product/app/../Eliza.apk" }),
  );
  assert.throws(
    () =>
      validateExpectation({
        ...expected,
        apkPath: "/product/priv-app/Eliza/Eliza.apk",
      }),
    /nonprivileged/,
  );
  assert.throws(() =>
    validateExpectation({ ...expected, packageName: "Eliza" }),
  );
  assert.throws(
    () => verifyLauncherImage(fixture().run, expected, "0", "grizzly"),
    /Unknown launcher image target/,
  );
  const base = [
    "--user",
    "0",
    "--descriptor",
    "d.json",
    "--fingerprint",
    "f",
    "--apk-path",
    "/product/app/E/E.apk",
    "--out",
    "r.json",
  ];
  assert.throws(
    () => parseArgs(["--target", "cuttlefish", "--serial", "device", ...base]),
    /loopback/,
  );
  assert.throws(
    () =>
      parseArgs([
        "--target",
        "pixel10a",
        "--serial",
        "127.0.0.1:6520",
        ...base,
      ]),
    /USB serial/,
  );
  assert.throws(
    () =>
      parseArgs(["--serial", "127.0.0.1:6520", "--serial", "localhost:6520"]),
    /duplicate/,
  );
  assert.equal(
    parseArgs(["--serial", "127.0.0.1:6520", ...base], "cuttlefish")[
      "--target"
    ],
    "cuttlefish",
  );
  assert.throws(
    () =>
      parseArgs(
        ["--target", "pixel10a", "--serial", "127.0.0.1:6520", ...base],
        "cuttlefish",
      ),
    /Only --target cuttlefish/,
  );
  assert.equal(
    parseArgs([
      "--target",
      "pixel10a",
      "--serial",
      "1A2B3C4D5E",
      "--listener",
      ...base,
    ])["--listener"],
    true,
  );
});
