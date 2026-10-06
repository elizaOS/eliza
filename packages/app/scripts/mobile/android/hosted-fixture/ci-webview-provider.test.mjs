import {
  candidate,
  createHostedWebViewProvisioner,
} from "./webview-provider.mjs";

const {
  main,
  requireProviderFixture,
  stockPath,
  verifyMetadata,
  collectOverlayFailureDiagnostics,
} = createHostedWebViewProvisioner({
  forbiddenPackagePrefixes: ["com.example.consumer."],
});

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const env = {
  GITHUB_ACTIONS: "true",
  RUNNER_ENVIRONMENT: "github-hosted",
  ANDROID_SERIAL: "emulator-5554",
};
const responses = {
  "shell cat /proc/bootconfig":
    'androidboot.boot_devices = "pci0000:00/0000:00:03.0 pci0000:00/0000:00:05.0 pci0000:00/0000:00:06.0"',
  "shell getprop ro.boot.boot_devices":
    "pci0000:00/0000:00:03.0 pci0000:00/0000:00:05.0 pci0000:00/0000:00:06.0",
  "shell readlink -f /dev/block/by-name/vdc": "/dev/block/vdc",
  "shell readlink -f /sys/class/block/vdc":
    "/sys/devices/pci0000:00/0000:00:05.0/virtio3/block/vdc",
  "shell readlink -f /sys/class/block/vda":
    "/sys/devices/pci0000:00/0000:00:03.0/virtio1/block/vda",
  "shell readlink -f /sys/class/block/vdd":
    "/sys/devices/pci0000:00/0000:00:06.0/virtio4/block/vdd",

  "emu avd name": "test\nOK",
  "shell getprop ro.kernel.qemu": "1",
  "shell getprop ro.build.type": "userdebug",
  "shell am get-current-user": "0",
  "shell pm list users": "Users:\nUserInfo{0:Owner:4c13}",
  "shell getprop ro.build.version.sdk": "35",
  "shell getprop ro.product.cpu.abi": "x86_64",
  "shell getprop ro.build.flavor": "sdk_phone64_x86_64-userdebug",
  "shell pm list packages -3": "",
  "shell pm list packages": "package:com.android.webview",
  "shell dumpsys activity processes": "ACTIVITY MANAGER RUNNING PROCESSES",
};
test("provider admission rejects wrong fixtures before any mutation", () => {
  for (const [key, value] of Object.entries({
    "emu avd name": "personal",
    "shell getprop ro.kernel.qemu": "0",
    "shell getprop ro.build.type": "user",
    "shell am get-current-user": "10",
    "shell pm list users": "UserInfo{0:Owner:4c13}\nUserInfo{10:Other:4}",
    "shell getprop ro.build.version.sdk": "34",
    "shell getprop ro.product.cpu.abi": "arm64-v8a",
    "shell getprop ro.build.flavor": "sdk_gphone_x86_64-userdebug",
    "shell pm list packages -3": "package:personal.app",
    "shell pm list packages": "package:com.google.android.gms",
    "shell dumpsys activity processes":
      "ACTIVITY MANAGER ActiveInstrumentation{",
  })) {
    const observed = [];
    assert.throws(() =>
      requireProviderFixture((...args) => {
        const command = args.join(" ");
        observed.push(command);
        assert.ok(command in responses, "Unexpected device operation");
        return command === key ? value : responses[command];
      }, env),
    );
    assert.ok(observed.length > 0);
  }
  assert.throws(() =>
    requireProviderFixture(() => assert.fail("device access"), {
      ...env,
      RUNNER_ENVIRONMENT: "self-hosted",
    }),
  );
  requireProviderFixture((...args) => responses[args.join(" ")], env);
});
test("stock provider removal admits one known AOSP file only", () => {
  const dump = "versionName=124.0.6367.219";
  assert.equal(
    stockPath("package:/product/app/webview/webview.apk", dump),
    "/product/app/webview/webview.apk",
  );
  for (const paths of [
    "package:/data/app/webview.apk",
    "package:/product/app/webview/../other.apk",
    "package:/product/app/Chrome/Chrome.apk",
    "package:/product/app/webview/a.apk\npackage:/product/app/webview/b.apk",
  ])
    assert.throws(() => stockPath(paths, dump));
  assert.throws(() =>
    stockPath(
      "package:/product/app/webview/webview.apk",
      `${dump} UPDATED_SYSTEM_APP`,
    ),
  );
});
test("provider provenance rejects altered signer ABI and dependency metadata", () => {
  const sig = `Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${candidate.certificateSha256}`;
  const badge = `package: name='com.android.webview' versionCode='808300007' versionName='157.0.8083.0'\nsdkVersion:'29'\ntargetSdkVersion:'37'\nnative-code: 'x86' 'x86_64'`;
  const manifest = "com.android.webview.WebViewLibrary libwebviewchromium.so";
  verifyMetadata(sig, badge, manifest);
  assert.throws(() =>
    verifyMetadata(
      sig.replace(candidate.certificateSha256, "0".repeat(64)),
      badge,
      manifest,
    ),
  );
  assert.throws(() =>
    verifyMetadata(sig, badge.replace("x86_64", "arm64-v8a"), manifest),
  );
  assert.throws(() =>
    verifyMetadata(sig, badge, `${manifest} E: uses-static-library`),
  );
  assert.match(candidate.archiveSha256, /^[a-f0-9]{64}$/);
  assert.match(candidate.apkSha256, /^[a-f0-9]{64}$/);
  const source = fs.readFileSync(
    new URL("./webview-provider.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(!source.includes("run('shell', 'rm', '-r'"));
});

import os from "node:os";
import path from "node:path";

async function simulate({
  oversizedAnr = false,
  framework = "ready",
  drift,
  neverBoot = false,
  neverReady = false,
  remountChannel = "stdout",
  remountStatus = 0,
  remountSignal = null,
} = {}) {
  const parent = fs.mkdtempSync(
    path.join(os.tmpdir(), "hosted-provider-sequence-"),
  );
  const output = path.join(parent, "evidence"),
    calls = [];
  let elapsed = 0,
    installed = false,
    removed = false,
    stopped = false,
    rebooted = false,
    offline = 0,
    selectionReads = 0,
    rooted = false;
  const stock = "/product/app/webview/webview.apk",
    stockHash = "a".repeat(64);
  const signature = `Verified using v2 scheme (APK Signature Scheme v2): true\nSigner #1 certificate SHA-256 digest: ${candidate.certificateSha256}`;
  const badging = `package: name='com.android.webview' versionCode='808300007' versionName='157.0.8083.0'\nsdkVersion:'29'\ntargetSdkVersion:'37'\nnative-code: 'x86_64'`;
  let finalBoot = false;
  let frameworkReads = 0,
    pidReads = 0,
    frameworkReady = false;
  let scratch = "",
    backingAlias = "/dev/block/vdc",
    remounts = 0,
    reboots = 0,
    probe = null,
    probeMarker = null,
    userReads = 0,
    restarted = false;
  const execute = (file, args, options) => {
    const name = path.basename(file);
    if (name === "curl") {
      const fd = fs.openSync(args.at(-1), "wx");
      fs.ftruncateSync(fd, candidate.size);
      fs.closeSync(fd);
      return "";
    }
    if (name === "python3") {
      fs.writeFileSync(args.at(-1), "candidate");
      return "";
    }
    if (name === "apksigner") return signature;
    if (name === "aapt")
      return args.includes("badging")
        ? badging
        : "com.android.webview.WebViewLibrary libwebviewchromium.so";
    assert.equal(name, "adb");
    assert.deepEqual(args.slice(0, 2), ["-s", "emulator-5554"]);
    const a = args.slice(2),
      key = a.join(" ");
    calls.push(key);
    if (
      [
        "shell cat /proc/bootconfig",
        "shell getprop ro.boot.boot_devices",
        "shell readlink -f /sys/class/block/vdc",
        "shell readlink -f /sys/class/block/vda",
        "shell readlink -f /sys/class/block/vdd",
      ].includes(key)
    ) {
      assert.ok(options.timeout > 0 && options.timeout <= 2000);
      if (drift === "boot-budget") elapsed += 4000;
    }
    if (key === "shell cat /proc/bootconfig" && !rooted)
      throw Error("cat: /proc/bootconfig: Permission denied");
    if (key === "root") {
      if (
        drift === "root-unavailable" ||
        (drift === "boot-root-denied" && rebooted)
      )
        throw Error("adbd root unavailable");
      if (
        !rebooted &&
        [
          "root-lost-ack",
          "root-lost-ack-unprivileged",
          "root-lost-ack-restarted",
        ].includes(drift)
      ) {
        rooted = drift !== "root-lost-ack-unprivileged";
        throw Object.assign(Error("root transport closed"), {
          status: 1,
          signal: null,
          stderr: "adb: unable to connect for root: closed\n",
        });
      }
      rooted = true;
      return "";
    }
    if (key === "reboot") {
      if (installed) finalBoot = true;
      rooted = false;
      reboots++;
      rebooted = true;
      offline = 1;
      scratch = "";
      backingAlias = "/dev/block/vdc";
      return "";
    }
    if (key === "shell getprop sys.boot_completed") {
      if (
        offline-- > 0 ||
        neverBoot ||
        (finalBoot && drift === "final-never-boot") ||
        (drift === "overlay-never-boot" && reboots > 1)
      )
        throw Error("device offline");
      return "1";
    }
    if (key === "shell cmd activity get-started-user-state 0") {
      userReads++;
      return restarted &&
        (drift === "user-never-ready" ||
          (drift === "user-delayed" && userReads < 3))
        ? "RUNNING_LOCKED"
        : "RUNNING_UNLOCKED";
    }
    if (
      finalBoot &&
      drift === "final-fingerprint" &&
      key === "shell getprop ro.build.fingerprint"
    )
      return "unreviewed-image";
    if (
      finalBoot &&
      drift === "final-alias" &&
      key === "shell readlink -f /dev/block/by-name/vdc"
    )
      return "/dev/block/vdd";
    if (
      finalBoot &&
      drift === "final-topology" &&
      key === "shell cat /proc/bootconfig"
    )
      return 'androidboot.boot_devices = "wrong"';
    if (key === "shell cat /proc/sys/kernel/random/boot_id")
      return (finalBoot && drift === "final-changed-boot") ||
        (rooted && drift === "root-lost-ack-restarted")
        ? "22222222-2222-4222-8222-222222222222"
        : "11111111-1111-4111-8111-111111111111";
    if (key === `shell test ! -e ${stock}`) {
      if (drift === "final-stock") throw Error("Stock provider returned");
      return "";
    }
    if (key === "shell dumpsys connectivity")
      return "Active default network: 100\n NetworkAgentInfo{network{100} handle{1} nc{[ Transports: WIFI Capabilities: INTERNET&VALIDATED]}";
    if (key === "shell dumpsys power") return "mWakefulness=Awake";
    if (key === "shell dumpsys window policy")
      return `KeyguardServiceDelegate\nshowing=false\ninputRestricted=false\nsecure=${drift === "final-secure"}\nsystemIsReady=true\nbootCompleted=true\nscreenState=SCREEN_STATE_ON\nKeyguardStateMonitor\nmCurrentUserId=0\nmIsShowing=false\nmInputRestricted=false`;
    if (key === "shell dumpsys activity activities")
      return drift?.startsWith("final-anr")
        ? "mCurrentFocus=Application Not Responding: com.android.systemui"
        : "ACTIVITY MANAGER ACTIVITIES";
    if (finalBoot && drift === "final-identity" && key === "emu avd name")
      return "personal";
    if (
      finalBoot &&
      drift === "final-bytes" &&
      key.startsWith("shell sha256sum /data/app/")
    )
      return "b".repeat(64);
    if (
      finalBoot &&
      drift === "final-scratch" &&
      key === "shell cat /sys/dev/block/254:5/size"
    )
      return "92280";
    if (key.startsWith("shell service check "))
      return `Service ${a.at(-1)}: found`;
    if (key === "shell id -u") return rooted ? "0" : "2000";
    if (key === "shell pidof netd")
      return finalBoot && drift !== "final-stale-netd" ? "603" : "602";
    if (key === "shell stop netd" || key === "shell start netd") return "";
    if (key === "shell pidof system_server") {
      pidReads++;
      if (removed && framework === "rotating")
        return String(200 + (pidReads % 2));
      return finalBoot && drift !== "final-stale-server"
        ? "300"
        : removed && framework !== "stale-server"
          ? "200"
          : "100";
    }
    if (/^shell cat \/proc\/[0-9]+\/stat$/.test(key)) {
      assert.equal(
        rooted,
        true,
        "system_server stat must only run after authenticated adb root",
      );
      const pid = a.at(-1).split("/")[2];
      return `${pid} (system_server) S ${Array(18).fill("0").join(" ")} ${pid === "100" ? "1000" : pid === "200" ? "2000" : "3000"} 0`;
    }
    if (key === "shell dumpsys activity -a processes") {
      if (removed) frameworkReads++;
      frameworkReady =
        !(finalBoot && drift === "final-not-ready") &&
        (!removed ||
          (framework !== "never-ready" &&
            (framework !== "delayed" || frameworkReads >= 3)));
      const row = `  mProcessesReady=${frameworkReady} mSystemReady=${frameworkReady} mBooted=${frameworkReady} mFactoryTest=0`;
      if (removed && framework === "missing-flags")
        return "ACTIVITY MANAGER RUNNING PROCESSES";
      if (removed && framework === "duplicate-flags") return `${row}\n${row}`;
      return row;
    }

    if (
      finalBoot &&
      drift === "final-missing-scratch" &&
      key === "shell dmctl list devices"
    )
      return "Available Device Mapper Devices:\nuserdata : 254:42\n";
    if (key === "shell dmctl list devices")
      return `Available Device Mapper Devices:\n${rebooted || drift === "cached-scratch" ? "scratch : 254:5\n" : ""}`;
    if (key === "shell ls -1 /sys/dev/block/254:5/slaves")
      return drift === "super-scratch" ? "vda2" : "vdc";
    if (key === "shell cat /sys/dev/block/254:5/dm/name") return "scratch";
    if (
      key === "shell cat /sys/dev/block/254:5/size" &&
      drift === "overlay-before-size"
    )
      return "92280";
    if (
      key === "shell cat /sys/dev/block/254:5/size" &&
      drift === "overlay-size" &&
      reboots > 1
    )
      return "92280";
    if (key === "shell cat /sys/dev/block/254:5/size")
      return drift === "small-scratch" || drift === "cached-scratch"
        ? "92280"
        : "1048576";
    if (key === "shell getprop ro.build.fingerprint")
      return "Android/sdk_phone64_x86_64/emu64x:15/AE3A.240806.019/12368160:userdebug/test-keys";
    if (
      key === "shell cat /proc/mounts" ||
      key === "shell cat /proc/1/mounts"
    ) {
      let mounts = "/dev/block/dm-43 /data ext4 rw 0 0";
      if (drift?.startsWith("overlay-live")) {
        const readOnly =
          drift === "overlay-live-ro" ||
          (drift === "overlay-live-init-ro" && key.includes("/proc/1/"));
        mounts += `\noverlay /product overlay ${readOnly ? "ro" : "rw"},lowerdir=/product,upperdir=/mnt/scratch/overlay/product/upper,workdir=/mnt/scratch/overlay/product/work 0 0\n/dev/block/dm-5 /mnt/scratch f2fs rw 0 0`;
      }
      return mounts;
    }
    if (key === "shell cat /sys/class/block/dm-5/dm/name")
      return drift === "overlay-live-wrong-backing" ? "userdata" : "scratch";
    if (
      a[0] === "shell" &&
      a[1]?.startsWith("set -C; printf %s eliza-ci-overlay-")
    ) {
      const match =
        /^set -C; printf %s (eliza-ci-overlay-[0-9a-f-]{36}) > (\/product\/app\/webview\/\.eliza-ci-probe-[0-9a-f-]{36})$/.exec(
          a[1],
        );
      assert.ok(match);
      assert.equal(probe, null);
      probeMarker = match[1];
      probe = match[2];
      return "";
    }
    if (
      a[0] === "shell" &&
      a[1] === "test" &&
      a.at(-1).startsWith("/product/app/webview/.eliza-ci-probe-")
    ) {
      assert.notEqual(probe, a.at(-1));
      return "";
    }
    if (
      a[0] === "shell" &&
      a[1] === "cat" &&
      a[2].startsWith("/product/app/webview/.eliza-ci-probe-")
    ) {
      assert.equal(a[2], probe);
      return drift === "overlay-live-probe-mismatch" ? "foreign" : probeMarker;
    }
    if (
      a[0] === "shell" &&
      a[1] === "rm" &&
      a[2].startsWith("/product/app/webview/.eliza-ci-probe-")
    ) {
      assert.equal(a[2], probe);
      if (drift === "overlay-live-cleanup-failed")
        throw Error("probe cleanup failed");
      probe = null;
      return "";
    }
    if (key === "shell cat /sys/class/block/dm-43/dm/name") return "userdata";
    if (key === "shell ls -1 /sys/class/block/dm-43/slaves")
      return drift === "backing-device" ? "vdd" : "vdc";
    if (key === "shell cat /sys/class/block/vdc/dev") return "253:32";
    if (key === "shell stat -c %t:%T /dev/block/vdc") return "fd:20";
    if (key === "shell test -b /dev/block/vdc") return "";
    if (
      key.startsWith("shell sh -c ") &&
      drift === "overlay-alias" &&
      reboots > 1
    )
      return "/dev/block/vdd";
    if (key.startsWith("shell sh -c "))
      return drift === "backing-alias" ? "/dev/block/vdd" : backingAlias;
    if (key === "shell ln -sT /dev/block/vdc /dev/block/by-name/vdc") {
      assert.equal(backingAlias, "MISSING");
      backingAlias = "/dev/block/vdc";
      return "";
    }
    if (key === "shell readlink -f /dev/block/by-name")
      return "/dev/block/by-name";
    if (key === "shell readlink -f /dev/block/by-name/vdc")
      return drift === "boot-alias" ||
        (drift === "boot-alias-after-reboot" && rebooted)
        ? "/dev/block/by-name/vdc"
        : "/dev/block/vdc";
    if (key === "shell cat /proc/bootconfig" && drift === "boot-config")
      return 'androidboot.boot_devices = "wrong"';
    if (key === "shell getprop fs_mgr.overlayfs.data_scratch_size_mb")
      return drift === "scratch-existing"
        ? "2048"
        : drift === "scratch-unapplied"
          ? ""
          : scratch;
    if (key === "shell setprop fs_mgr.overlayfs.data_scratch_size_mb 512") {
      scratch = "512";
      return "";
    }
    if (key === "shell pidof surfaceflinger")
      return drift === "final-anr-foreign-pid" ? "7 8" : "407";
    if (key === "shell readlink -f /proc/407/exe")
      return drift === "final-anr-foreign-exe"
        ? "/system/bin/other"
        : "/system/bin/surfaceflinger";
    if (key === "shell debuggerd -b 407") {
      assert.ok(options.timeout > 0 && options.timeout <= 2000);
      assert.equal(options.maxBuffer, 256 * 1024);
      return `SurfaceFlinger main stack ${"x".repeat(70000)}`;
    }
    if (
      key ===
      "shell logcat -d -b main -t 1000 SurfaceFlinger:I RenderEngine:I EGL_emulation:I goldfish-address-space:I *:S"
    )
      return "synthetic bounded ANR evidence";
    if (key === "shell dumpsys dropbox --print system_app_anr") {
      assert.ok(options.timeout > 0 && options.timeout <= 2000);
      assert.equal(options.maxBuffer, 256 * 1024);
      const report = `ANR main thread ${"x".repeat(70000)}`;
      if (oversizedAnr) {
        const error = Error("maxBuffer exceeded");
        error.code = "ENOBUFS";
        error.stdout = report;
        throw error;
      }
      return report;
    }
    if (
      [
        "shell dumpsys activity lastanr",
        "shell dumpsys activity processes",
        "shell logcat -d -b events -t 400 am_anr:I am_crash:I *:S",
        "shell logcat -d -b system -t 400",
        "shell cat /proc/meminfo",
        "shell cat /proc/pressure/memory /proc/pressure/cpu /proc/pressure/io",
      ].includes(key) &&
      (key !== "shell dumpsys activity processes" ||
        options.maxBuffer === 256 * 1024)
    ) {
      assert.ok(options.timeout > 0 && options.timeout <= 2000);
      assert.equal(options.maxBuffer, 256 * 1024);
      return key === "shell dumpsys activity processes"
        ? "ACTIVITY MANAGER bounded synthetic ANR evidence"
        : "synthetic bounded ANR evidence";
    }
    if (key === "shell getprop ro.boot.super_partition") return "vda2";
    if (key === "shell readlink -f /dev/block/by-name/super")
      return "/dev/block/vda2";
    if (
      key.startsWith("shell ls -lZ ") ||
      key === "shell cat /sys/class/block/vda2/uevent" ||
      key.startsWith("shell lpdump --slot=") ||
      key ===
        "shell grep -e super -e vda -e vd_device /vendor/etc/selinux/vendor_file_contexts"
    ) {
      assert.ok(options.timeout > 0 && options.timeout <= 2000);
      return "synthetic super layout";
    }
    if (
      [
        "shell df -k /data /metadata /product",
        "shell cat /proc/mounts",
        "shell cat /proc/partitions",
        "shell lpdump",
        "shell lpdump /metadata/gsi/remount/lp_metadata",
        "shell dmesg",
      ].includes(key)
    )
      return "synthetic bounded storage diagnostics";
    if (key === "remount" && drift === "remount-failed") {
      const failure = new Error("remount failed");
      failure.stderr = "Failed to map scratch; make f2fs return=65280";
      throw failure;
    }
    if (key === "remount") {
      remounts++;
      if (
        drift?.startsWith("overlay-live") ||
        ([
          "overlay-reboot",
          "overlay-repeat",
          "overlay-identity",
          "overlay-stock",
          "overlay-size",
          "overlay-alias",
          "overlay-before-size",
          "overlay-never-boot",
        ].includes(drift) &&
          (remounts === 1 || drift === "overlay-repeat"))
      )
        return fs.readFileSync(
          new URL(
            "./fixtures/remount-52ab-overlay-reboot.txt",
            import.meta.url,
          ),
          "utf8",
        );
      if (drift === "overlay-unknown")
        return "Remount succeeded\nNow reboot your device for settings to take effect\nAnother reboot is required\n";
      return drift === "remount" ? "reboot required" : "remount succeeded";
    }
    if (["root", "wait-for-device", "disable-verity"].includes(key)) return "";
    if (key === "shell stop zygote") {
      stopped = true;
      return "";
    }
    if (key === "shell start zygote") {
      if (installed) finalBoot = true;
      stopped = false;
      restarted = true;
      userReads = 0;
      return "";
    }
    if (key === `shell rm ${stock}`) {
      assert.equal(stopped, true);
      removed = true;
      return "";
    }
    if (a[0] === "pull") {
      fs.writeFileSync(a[2], "stock");
      return "";
    }
    if (a[0] === "install") {
      if (drift === "user-delayed") assert.ok(userReads >= 3);
      assert.equal(
        frameworkReady,
        true,
        "Framework must complete before install",
      );
      if (framework === "install-fails")
        throw Error("recorded install failure");
      assert.equal(removed, true);
      assert.equal(stopped, false);
      installed = true;
      return "Success";
    }
    if (
      key ===
      "shell cmd webviewupdate set-webview-implementation com.android.webview"
    )
      return "Success";
    if (key === "shell dumpsys webviewupdate") {
      selectionReads++;
      return `Current WebView package (name, version): (com.android.webview, 157.0.8083.0)\nWebView package dirty: ${neverReady || selectionReads < 2 || (finalBoot && drift === "final-relro")}\nNumber of relros started: 1\nNumber of relros finished: ${neverReady || selectionReads < 2 ? 0 : 1}\nis installed/enabled for all users`;
    }
    if (key === "shell pm path com.android.webview")
      return installed
        ? "package:/data/app/provider/base.apk"
        : `package:${stock}`;
    if (key === "shell dumpsys package com.android.webview")
      return "versionName=124.0.6367.219";
    if (key.startsWith("shell sha256sum "))
      return `${installed ? candidate.apkSha256 : ((drift === "stock" && rebooted) || (drift === "overlay-stock" && reboots > 1) || (drift === "stopped-stock" && stopped)) ? "b".repeat(64) : stockHash}  ${a.at(-1)}`;
    if (key === "shell pm list packages com.android.webview")
      return removed ? "" : "package:com.android.webview";
    if (key === "shell pm list packages -3")
      return installed ? "package:com.android.webview" : "";
    if (
      key === "emu avd name" &&
      ((drift === "identity" && rebooted) ||
        (drift === "overlay-identity" && reboots > 1))
    )
      return "personal";
    assert.ok(key in responses, `Unexpected command: ${key}`);
    return responses[key];
  };
  let error;
  try {
    await main({
      environment: env,
      fixtureAcknowledgement: "api35-default-x86_64",
      execute,
      executeRemount: (file, args, options) => {
        const text = execute(file, args, options);
        return {
          status: remountStatus,
          signal: remountSignal,
          stdout: remountChannel === "stdout" ? text : "",
          stderr: remountChannel === "stderr" ? text : "",
        };
      },
      sdkEnvironment: { ANDROID_HOME: "/sdk" },
      outputDirectory: output,
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
      fileDigest: (f) =>
        path.basename(f) === "chromium.zip"
          ? candidate.archiveSha256
          : path.basename(f) === "SystemWebView.apk"
            ? candidate.apkSha256
            : stockHash,
    });
  } catch (caught) {
    error = caught;
  }
  const result = JSON.parse(fs.readFileSync(path.join(output, "result.json")));
  const diagnosticPath = path.join(
    output,
    "provider-restart-storage-diagnostics.json",
  );
  const diagnostics = fs.existsSync(diagnosticPath)
    ? JSON.parse(fs.readFileSync(diagnosticPath))
    : null;
  const superPath = path.join(output, "super-layout-before.json");
  const superLayout = fs.existsSync(superPath)
    ? JSON.parse(fs.readFileSync(superPath))
    : null;
  const anrPath = path.join(output, "provider-framework-anr.json");
  const anrDiagnostics = fs.existsSync(anrPath)
    ? JSON.parse(fs.readFileSync(anrPath))
    : null;
  const displayPath = path.join(output, "provider-framework-display.json");
  const displayDiagnostics = fs.existsSync(displayPath)
    ? JSON.parse(fs.readFileSync(displayPath))
    : null;
  fs.rmSync(parent, { recursive: true, force: true });
  return {
    displayDiagnostics,
    anrDiagnostics,
    superLayout,
    diagnostics,
    calls,
    result,
    error,
    stopped,
    removed,
    installed,
    selectionReads,
    elapsed,
  };
}
test("full provider command sequence survives one offline reboot and delayed RELRO", async () => {
  const r = await simulate();
  assert.ifError(r.error);
  assert.equal(r.result.status, "PROVISIONED_RUNTIME_QUALIFICATION_PENDING");
  assert.equal(r.result.runtimeFeaturesQualified, false);
  assert.ok(
    r.calls.indexOf("shell logcat -d -b all -t 400") <
      r.calls.indexOf("reboot"),
  );
  assert.equal(
    r.calls.filter(
      (c) => c === "shell setprop fs_mgr.overlayfs.data_scratch_size_mb 512",
    ).length,
    2,
  );
  assert.ok(
    r.calls.indexOf("shell setprop fs_mgr.overlayfs.data_scratch_size_mb 512") <
      r.calls.indexOf("disable-verity"),
  );
  assert.equal(
    r.calls.filter(
      (c) => c === "shell ln -sT /dev/block/vdc /dev/block/by-name/vdc",
    ).length,
    0,
  );
  assert.equal(r.result.bootDeviceAdmissions.length, 3);
  assert.ok(
    r.calls.indexOf("root") < r.calls.indexOf("shell cat /proc/bootconfig"),
  );
  assert.ok(
    r.calls.indexOf("shell cat /proc/bootconfig") <
      r.calls.indexOf(
        "shell setprop fs_mgr.overlayfs.data_scratch_size_mb 512",
      ),
  );
  assert.equal(r.result.scratchBackingAliases.length, 2);
  assert.equal(r.selectionReads, 3);
  assert.equal(r.stopped, false);
  assert.ok(
    r.calls.indexOf("shell stop zygote") <
      r.calls.indexOf("shell rm /product/app/webview/webview.apk"),
  );
  assert.ok(
    r.calls.indexOf("shell rm /product/app/webview/webview.apk") <
      r.calls.indexOf("shell start zygote"),
  );
});
test("provider main refuses identity stock and remount drift before deletion/install", async () => {
  for (const drift of ["identity", "stock", "remount"]) {
    const r = await simulate({ drift });
    assert.ok(r.error);
    assert.equal(r.removed, false);
    assert.equal(r.installed, false);
    assert.equal(r.result.status, "FAIL");
  }
});
test("offline boot and incomplete RELRO have fixed deadlines", async () => {
  const offline = await simulate({ neverBoot: true });
  assert.match(offline.error.message, /boot deadline/);
  assert.equal(offline.elapsed, 180000);
  assert.equal(offline.removed, false);
  const relro = await simulate({ neverReady: true });
  assert.match(relro.error.message, /RELRO readiness deadline/);
  assert.equal(relro.result.status, "FAIL");
  assert.equal(relro.elapsed, 62000);
  assert.equal(relro.result.runtimeFeaturesQualified, false);
});

test("framework starts again when stopped-provider hash check refuses deletion", async () => {
  const r = await simulate({ drift: "stopped-stock" });
  assert.match(r.error.message, /Stopped provider changed/);
  assert.equal(r.stopped, false);
  assert.equal(r.removed, false);
  assert.ok(r.calls.includes("shell start zygote"));
  assert.equal(r.installed, false);
});

test("scratch policy refuses drift before verity or provider mutations", async () => {
  for (const drift of ["scratch-existing", "scratch-unapplied"]) {
    const r = await simulate({ drift });
    assert.match(r.error.message, /scratch size policy|Scratch size policy/);
    assert.equal(r.calls.includes("disable-verity"), false);
    assert.equal(r.removed, false);
    assert.equal(r.installed, false);
  }
});
test("remount failure preserves cause and collects bounded read-only storage evidence", async () => {
  const r = await simulate({ drift: "remount-failed" });
  assert.match(r.error.message, /remount failed/);
  assert.equal(r.result.failedAt, "preparing-overlay-storage");
  assert.equal(r.removed, false);
  assert.equal(r.installed, false);
  const failed = r.result.commands.find(
    (c) => !c.success && c.args.at(-1) === "remount",
  );
  assert.match(failed.stderr, /make f2fs return=65280/);
  assert.equal(r.calls.filter((c) => c === "shell dmesg").length, 2);
});

test("diagnostics re-admit every query with finite time and output bounds", () => {
  let elapsed = 0,
    admissions = 0;
  const result = collectOverlayFailureDiagnostics({
    environment: env,
    sdkEnvironment: { ANDROID_HOME: "/sdk" },
    now: () => elapsed,
    hostPaths: { fixture: "/owned" },
    statfs: () => ({ bavail: 3, bfree: 4, bsize: 4096 }),
    execute: (_file, args, options) => {
      assert.ok(options.timeout > 0 && options.timeout <= 2000);
      assert.equal(options.maxBuffer, 256 * 1024);
      const key = args.slice(2).join(" ");
      if (key in responses) {
        if (key === "shell dumpsys activity processes") admissions++;
        return responses[key];
      }
      assert.equal(admissions, 1);
      admissions--;
      assert.ok(!/remount|setprop|reboot|mkfs| rm /.test(key));
      elapsed += 3000;
      return "gsid scratch detail\n".repeat(6000);
    },
  });
  assert.equal(result.host.fixture.availableBytes, 12288);
  for (const v of Object.values(result.guest))
    if (typeof v === "string") assert.ok(v.length <= 65536);
  assert.match(result.admissionStopped, /deadline/);
  assert.ok(elapsed <= 21000);
});
test("diagnostics reject drift before device details and retain host errors", () => {
  const result = collectOverlayFailureDiagnostics({
    environment: env,
    sdkEnvironment: { ANDROID_HOME: "/sdk" },
    hostPaths: { bad: "/absent" },
    statfs: () => {
      throw Error("unavailable");
    },
    execute: (_file, args) => {
      assert.equal(args.slice(2).join(" "), "emu avd name");
      return "personal";
    },
  });
  assert.ok(result.admissionStopped);
  assert.deepEqual(result.guest, {});
  assert.equal(result.host.bad.unavailable, "unavailable");
});

test("stock backup failure retains original error, provenance and bounded read-only evidence", async () => {
  for (const mode of ["normal", "drift", "expired"]) {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "stock-diagnostic-"));
    const output = path.join(parent, "evidence"),
      calls = [];
    let failed = false,
      tick = 0;
    const original = Object.assign(new Error("pull failure"), {
      status: 1,
      signal: null,
      code: null,
      stdout: "",
      stderr: "",
    });
    const execute = (file, args, opts) => {
      assert.equal(path.basename(file), "adb");
      const a = args.slice(2),
        key = a.join(" ");
      calls.push(key);
      if (a[0] === "pull") {
        assert.equal(opts.timeout, 20000);
        assert.deepEqual(
          JSON.parse(fs.readFileSync(path.join(output, "result.json"))).stock,
          { path: "/product/app/webview/webview.apk", sha256: "a".repeat(64) },
        );
        fs.writeFileSync(a[2], "partial");
        failed = true;
        tick += 13;
        throw original;
      }
      if (failed) {
        assert.ok(opts.timeout > 0 && opts.timeout <= 2000);
        if (mode === "drift" && key === "emu avd name") return "personal";
      }
      if (key in responses) return responses[key];
      if (key === "shell pm path com.android.webview")
        return "package:/product/app/webview/webview.apk";
      if (key === "shell dumpsys package com.android.webview")
        return "versionName=124.0.6367.219";
      if (key === "shell sha256sum /product/app/webview/webview.apk")
        return "a".repeat(64);
      assert.ok(
        [
          "version",
          "get-state",
          "shell getprop ro.build.fingerprint",
          "shell stat -c %s /product/app/webview/webview.apk",
          "shell df -k /data /metadata /product",
        ].includes(key),
        key,
      );
      return "readonly evidence";
    };
    try {
      await assert.rejects(
        main({
          environment: env,
          fixtureAcknowledgement: "api35-default-x86_64",
          sdkEnvironment: { ANDROID_HOME: parent },
          outputDirectory: output,
          execute,
          now: () => {
            if (failed && mode === "expired") tick += 25000;
            return tick;
          },
        }),
        (e) => e === original,
      );
      const r = JSON.parse(fs.readFileSync(path.join(output, "result.json"))),
        d = JSON.parse(
          fs.readFileSync(
            path.join(output, "stock-backup-failure-diagnostics.json"),
          ),
        );
      assert.equal(r.status, "FAIL");
      assert.equal(r.failedAt, "preflight");
      const pull = r.commands.find((c) => c.args[2] === "pull");
      assert.equal(pull.status, 1);
      assert.equal(pull.signal, null);
      assert.equal(pull.code, null);
      assert.ok(pull.durationMilliseconds >= 13);
      assert.equal(d.host.partialBackupBytes, 7);
      assert.equal(d.budgetMilliseconds, 20000);
      assert.ok(Object.hasOwn(d.host, "imageSourceProperties"));
      assert.equal(calls.filter((c) => c.startsWith("pull ")).length, 1);
      if (mode === "normal")
        assert.deepEqual(Object.keys(d.guest), [
          "adbVersion",
          "deviceState",
          "fingerprint",
          "stockStat",
          "capacity",
        ]);
      else {
        assert.ok(d.admissionStopped);
        assert.deepEqual(d.guest, {});
      }
      assert.ok(
        !calls.some((c) =>
          /^(root|remount|reboot|install|shell (rm|setprop|stop|start))\b/.test(
            c,
          ),
        ),
      );
    } finally {
      fs.rmSync(parent, { recursive: true, force: true });
    }
  }
});

test("provider preparation refuses userdata or alias drift before verity/provider changes", async () => {
  for (const drift of ["backing-device", "backing-alias"]) {
    const r = await simulate({ drift });
    assert.ok(r.error);
    assert.equal(r.calls.includes("disable-verity"), false);
    assert.equal(
      r.calls.some((call) => call.startsWith("shell ln ")),
      false,
    );
    assert.equal(r.removed, false);
    assert.equal(r.installed, false);
  }
});

test("cached or undersized scratch never qualifies provider replacement", async () => {
  for (const drift of ["cached-scratch", "small-scratch", "super-scratch"]) {
    const r = await simulate({ drift });
    assert.match(
      r.error.message,
      /Existing scratch|512MiB data scratch|proven userdata backing/,
    );
    assert.equal(r.removed, false);
    assert.equal(r.installed, false);
    if (drift === "cached-scratch") {
      assert.equal(r.calls.includes("disable-verity"), false);
      assert.equal(
        r.calls.some((call) => call.startsWith("shell ln ")),
        false,
      );
    }
  }
});

test("one authenticated requested overlay activation reboot completes provider flow", async () => {
  const r = await simulate({ drift: "overlay-reboot" });
  assert.ifError(r.error);
  assert.equal(r.result.status, "PROVISIONED_RUNTIME_QUALIFICATION_PENDING");
  assert.equal(r.calls.filter((c) => c === "reboot").length, 2);
  assert.equal(r.calls.filter((c) => c === "remount").length, 2);
  assert.equal(r.result.scratchBackingAliases.length, 3);
  assert.equal(r.result.scratchBytes, 512 * 1024 * 1024);
  assert.equal(r.installed, true);
});
test("requested overlay reboot refuses repeat, unknown wording, changed identity, stock, backing and size", async () => {
  for (const drift of [
    "overlay-repeat",
    "overlay-unknown",
    "overlay-identity",
    "overlay-stock",
    "overlay-size",
    "overlay-alias",
    "overlay-before-size",
    "overlay-never-boot",
  ]) {
    const r = await simulate({ drift });
    assert.ok(r.error, drift);
    assert.equal(r.installed, false, drift);
    assert.equal(r.removed, false, drift);
    assert.ok(r.calls.filter((c) => c === "reboot").length <= 2, drift);
  }
});

test("stderr-only remount transcript follows the bounded overlay reboot flow", async () => {
  const r = await simulate({
    drift: "overlay-reboot",
    remountChannel: "stderr",
  });
  assert.ifError(r.error);
  assert.equal(r.calls.filter((c) => c === "reboot").length, 2);
  assert.equal(r.calls.filter((c) => c === "remount").length, 2);
  assert.match(r.result.overlayRemountOutputs[0], /Now reboot your device/);
  assert.equal(r.result.scratchBytes, 512 * 1024 * 1024);
  assert.equal(r.installed, true);
});
test("successful-looking remount stderr never overrides failed exit or termination", async () => {
  for (const option of [
    { remountStatus: 1 },
    { remountStatus: null, remountSignal: "SIGTERM" },
  ]) {
    const r = await simulate({ remountChannel: "stderr", ...option });
    assert.match(r.error.message, /remount failed/);
    assert.equal(r.removed, false);
    assert.equal(r.installed, false);
    const failed = r.result.commands.find(
      (c) => !c.success && c.args.at(-1) === "remount",
    );
    assert.match(failed.stderr, /remount succeeded/);
  }
});

test("repeated emulator reboot advisory requires live overlay proof and removed write probe", async () => {
  const r = await simulate({ drift: "overlay-live", remountChannel: "stderr" });
  assert.ifError(r.error);
  assert.equal(r.calls.filter((c) => c === "reboot").length, 2);
  assert.equal(r.calls.filter((c) => c === "remount").length, 2);
  assert.deepEqual(r.result.liveOverlayProof, {
    namespaces: ["shell", "init"],
    scratchBytes: 512 * 1024 * 1024,
    writeProbeRemoved: true,
  });
  const removedProbe = r.calls.findIndex((c) =>
    c.startsWith("shell rm /product/app/webview/.eliza-ci-probe-"),
  );
  assert.ok(
    removedProbe > 0 &&
      removedProbe <
        r.calls.indexOf("shell rm /product/app/webview/webview.apk"),
  );
  assert.equal(r.installed, true);
});
test("live overlay admission refuses namespace, backing and write-probe failures before provider removal", async () => {
  for (const drift of [
    "overlay-live-ro",
    "overlay-live-init-ro",
    "overlay-live-wrong-backing",
    "overlay-live-probe-mismatch",
    "overlay-live-cleanup-failed",
  ]) {
    const r = await simulate({ drift });
    assert.ok(r.error, drift);
    assert.equal(r.removed, false, drift);
    assert.equal(r.installed, false, drift);
  }
});

// Binder services and the old boot property can be visible before the restarted framework is usable.
test("provider installation waits for the restarted primary user to be running unlocked", async () => {
  const delayed = await simulate({ drift: "user-delayed" });
  assert.ifError(delayed.error);
  assert.equal(delayed.installed, true);
  const unavailable = await simulate({ drift: "user-never-ready" });
  assert.match(unavailable.error.message, /boot deadline/);
  assert.equal(unavailable.installed, false);
});

test("boot identity drift refuses before provider effects and never creates a late alias", async () => {
  for (const drift of [
    "boot-alias",
    "boot-config",
    "boot-alias-after-reboot",
    "boot-budget",
  ]) {
    const r = await simulate({ drift });
    assert.ok(r.error);
    assert.equal(r.removed, false);
    assert.equal(r.installed, false);
    assert.ok(!r.calls.some((call) => call.startsWith("shell ln")));
    if (drift !== "boot-budget") {
      assert.ok(r.result.bootDeviceReadbacks.length > 0);
      if (drift === "boot-config")
        assert.equal(
          r.result.bootDeviceReadbacks[0].bootconfig,
          'androidboot.boot_devices = "wrong"',
        );
    }
    if (drift !== "boot-alias-after-reboot") {
      assert.ok(!r.calls.includes("disable-verity"));
      assert.ok(!r.calls.some((c) => c.startsWith("shell setprop ")));
    }
  }
});

test("root-unavailable fixture fails before privileged boot read or any provider mutation", async () => {
  const r = await simulate({ drift: "root-unavailable" });
  assert.match(r.error.message, /adbd root unavailable/);
  assert.equal(r.result.status, "FAIL");
  assert.equal(r.removed, false);
  assert.equal(r.installed, false);
  assert.ok(!r.calls.includes("shell cat /proc/bootconfig"));
  assert.ok(
    !r.calls.some((c) =>
      /^(disable-verity|remount|reboot|install|shell (rm|setprop|stop|start))\b/.test(
        c,
      ),
    ),
  );
});

test("closed root acknowledgement is reconciled by identity and uid without replay", async () => {
  const r = await simulate({ drift: "root-lost-ack" });
  assert.ifError(r.error);
  assert.equal(r.result.rootDisconnectReconciled, true);
  assert.equal(
    r.calls.slice(0, r.calls.indexOf("reboot")).filter((c) => c === "root")
      .length,
    1,
  );
  assert.equal(r.installed, true);
});
for (const drift of ["root-lost-ack-unprivileged", "root-lost-ack-restarted"])
  test(`closed root acknowledgement refuses ${drift}`, async () => {
    const r = await simulate({ drift });
    assert.match(r.error.message, /root transport closed/);
    assert.equal(r.calls.filter((c) => c === "root").length, 1);
    assert.equal(r.installed, false);
    assert.equal(r.removed, false);
    assert.ok(
      !r.calls.some((c) =>
        /^(disable-verity|remount|reboot|install|shell (rm|setprop|stop|start))\b/.test(
          c,
        ),
      ),
    );
  });

test("framework restart waits past published binders and stale boot property before installing once", async () => {
  const r = await simulate({ framework: "delayed" });
  assert.ifError(r.error);
  assert.equal(r.installed, true);
  const start = r.calls.indexOf("shell start zygote"),
    install = r.calls.findIndex((call) => call.startsWith("install "));
  assert.ok(start >= 0 && install > start);
  assert.equal(r.calls.filter((call) => call.startsWith("install ")).length, 1);
  assert.equal(
    r.calls
      .slice(start, install)
      .filter((call) => call === "shell dumpsys activity -a processes").length,
    3,
  );
  const admission = r.result.frameworkAdmissions.at(-1);
  assert.equal(admission.ready, true);
  assert.notDeepEqual(admission.previousServer, admission.after);
  assert.deepEqual(admission.before, admission.after);
});
test("framework incomplete, stale generation or rotating identity never dispatches install", async () => {
  for (const framework of [
    "never-ready",
    "stale-server",
    "rotating",
    "missing-flags",
    "duplicate-flags",
  ]) {
    const r = await simulate({ framework });
    assert.match(r.error.message, /boot deadline exceeded/);
    assert.equal(r.removed, true);
    assert.equal(r.installed, false);
    assert.ok(!r.calls.some((call) => call.startsWith("install ")));
    assert.ok(
      r.calls.filter((call) => call === "shell dumpsys activity -a processes")
        .length <= 181,
    );
    assert.equal(r.elapsed, 182000);
  }
});
test("a failed provider install is never retried after successful framework admission", async () => {
  const r = await simulate({ framework: "install-fails" });
  assert.match(r.error.message, /recorded install failure/);
  assert.equal(r.calls.filter((call) => call.startsWith("install ")).length, 1);
});

test("postreboot root refusal is never replayed and never reaches privileged stat or install", async () => {
  const r = await simulate({ drift: "boot-root-denied" });
  assert.match(r.error.message, /boot deadline exceeded/);
  assert.equal(r.removed, false);
  assert.equal(r.installed, false);
  const after = r.calls.slice(r.calls.indexOf("reboot") + 1);
  assert.equal(after.filter((call) => call === "root").length, 1);
  assert.ok(
    !after.some((call) => /^shell cat \/proc\/[0-9]+\/stat$/.test(call)),
  );
  assert.ok(!after.some((call) => call.startsWith("install ")));
});

test("successful replacement requires a new framework generation without losing the kernel overlay", async () => {
  const r = await simulate();
  assert.ifError(r.error);
  const installs = r.calls
    .map((v, i) => (v.startsWith("install ") ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(installs.length, 1);
  const reboots = r.calls
    .map((v, i) => (v === "reboot" ? i : -1))
    .filter((i) => i >= 0);
  assert.equal(reboots.length, 1);
  assert.ok(reboots[0] < installs[0]);
  const finalStart = r.calls.lastIndexOf("shell start zygote");
  assert.ok(finalStart > installs[0]);
  assert.equal(r.calls.filter((c) => c === "shell stop zygote").length, 2);
  assert.ok(
    !r.calls.includes("shell stop") && !r.calls.includes("shell start"),
  );
  assert.notDeepEqual(
    r.result.providerRestart.previousServer,
    r.result.providerRestart.server,
  );
  assert.ok(
    r.calls.lastIndexOf("shell stop zygote") <
      r.calls.indexOf("shell stop netd"),
  );
  assert.ok(
    r.calls.indexOf("shell stop netd") < r.calls.indexOf("shell start netd"),
  );
  assert.ok(r.calls.indexOf("shell start netd") < finalStart);
  assert.deepEqual(r.result.providerRestart.netd, {
    before: "602",
    after: "603",
  });
  assert.deepEqual(
    r.result.providerChecks.map((c) => c.label),
    ["after-install", "after-framework-restart"],
  );
  assert.equal(
    r.result.providerRestart.priorBootId,
    r.result.providerRestart.bootId,
  );
  assert.equal(r.result.providerDisplayObservations.length, 2);
  assert.ok(
    r.result.providerDisplayObservations.every(
      (o) => o.secure === false && o.unlocked,
    ),
  );
  assert.ok(
    !r.calls
      .slice(finalStart + 1)
      .some((c) =>
        /^(install |reboot$|shell (rm |locksettings |input |wm dismiss))/.test(
          c,
        ),
      ),
  );
});
test("postreplacement framework restart refuses identity, provenance, readiness, secure state and ANR without replay", async () => {
  for (const drift of [
    "final-never-boot",
    "final-changed-boot",
    "final-stale-server",
    "final-stale-netd",
    "final-not-ready",
    "final-identity",
    "final-stock",
    "final-fingerprint",
    "final-alias",
    "final-topology",
    "final-bytes",
    "final-scratch",
    "final-relro",
    "final-secure",
    "final-anr",
  ]) {
    const r = await simulate({ drift });
    assert.ok(r.error, drift);
    assert.equal(r.result.status, "FAIL");
    assert.equal(r.calls.filter((c) => c.startsWith("install ")).length, 1);
    assert.equal(r.calls.filter((c) => c === "reboot").length, 1);
    if (drift === "final-secure")
      assert.match(r.error.message, /not observed awake/);
    if (drift?.startsWith("final-anr"))
      assert.match(r.error.message, /ANR remains/);
  }
});

test("missing postrestart scratch retains bounded storage evidence and refuses without later mutations", async () => {
  const r = await simulate({ drift: "final-missing-scratch" });
  assert.match(
    r.error.message,
    /Provider restart lost authenticated data scratch/,
  );
  assert.equal(r.result.providerRestart.scratchBytes, null);
  assert.match(r.diagnostics.guest.deviceMapperNames, /userdata : 254:42/);
  for (const key of [
    "superPartition",
    "superAlias",
    "superLabels",
    "superUevent",
    "superSlot0",
    "superSlot1",
    "vendorBlockContexts",
    "mounts",
    "scratchMetadata",
    "userspaceStorageLog",
    "capacity",
    "stockStat",
    "providerPath",
    "providerState",
    "kernel",
  ])
    assert.ok(Object.hasOwn(r.diagnostics.guest, key), key);
  assert.equal(r.diagnostics.budgetMilliseconds, 20000);
  assert.equal(r.calls.filter((c) => c.startsWith("install ")).length, 1);
  const finalReboot = r.calls.lastIndexOf("shell start zygote");
  assert.equal(r.calls.filter((c) => c === "reboot").length, 1);
  assert.ok(
    !r.calls
      .slice(finalReboot + 1)
      .some((c) =>
        /^(install |reboot$|remount$|shell (rm |setprop |stop$|start$|input |locksettings |wm dismiss))/.test(
          c,
        ),
      ),
  );
  assert.deepEqual(
    r.result.providerChecks.map((c) => c.label),
    ["after-install"],
  );
});

test("super layout is read before any remount without adding install or reboot", async () => {
  const r = await simulate();
  assert.ifError(r.error);
  assert.equal(r.superLayout.guest.superPartition, "vda2");
  assert.equal(r.superLayout.guest.superAlias, "/dev/block/vda2");
  assert.ok(
    r.calls.indexOf("shell lpdump --slot=0 /dev/block/by-name/super") <
      r.calls.indexOf("remount"),
  );
  assert.ok(
    r.calls.indexOf("shell lpdump --slot=1 /dev/block/by-name/super") <
      r.calls.indexOf("remount"),
  );
  assert.equal(r.calls.filter((c) => c.startsWith("install ")).length, 1);
  assert.equal(r.calls.filter((c) => c === "reboot").length, 1);
});

test("focused framework ANR preserves bounded read-only evidence without accepting or retrying setup", async () => {
  const r = await simulate({ drift: "final-anr" });
  assert.match(r.error.message, /Application ANR remains/);
  assert.equal(r.result.status, "FAIL");
  assert.deepEqual(Object.keys(r.anrDiagnostics.guest), [
    "displayPolicy",
    "powerState",
    "surfaceFlingerBacktrace",
    "graphicsLog",
    "systemAppAnr",
    "lastAnr",
    "processes",
    "anrEvents",
    "systemLog",
    "memory",
    "pressure",
  ]);
  assert.equal(r.anrDiagnostics.budgetMilliseconds, 20000);
  for (const [key, value] of Object.entries(r.anrDiagnostics.guest).filter(
    ([key]) => !["displayPolicy", "powerState"].includes(key),
  ))
    assert.equal(
      value,
      key === "surfaceFlingerBacktrace"
        ? `SurfaceFlinger main stack ${"x".repeat(70000)}`.slice(0, 65536)
        : key === "systemAppAnr"
          ? `ANR main thread ${"x".repeat(70000)}`.slice(0, 65536)
          : key === "processes"
            ? "ACTIVITY MANAGER bounded synthetic ANR evidence"
            : "synthetic bounded ANR evidence",
    );
  const start = r.calls.indexOf("shell dumpsys dropbox --print system_app_anr");
  assert.ok(start > 0);
  assert.ok(
    !r.calls
      .slice(start)
      .some((c) =>
        /^(install |reboot$|remount$|shell (stop$|start$|input |am force-stop|kill))/.test(
          c,
        ),
      ),
  );
  assert.equal(r.calls.filter((c) => c === "reboot").length, 1);
  assert.equal((await simulate()).anrDiagnostics, null);
});

test("oversized ANR reports retain a bounded leading stack without changing failure", async () => {
  const r = await simulate({ drift: "final-anr", oversizedAnr: true });
  assert.match(r.error.message, /Application ANR remains/);
  assert.equal(r.result.status, "FAIL");
  const report = r.anrDiagnostics.guest.systemAppAnr;
  assert.equal(report.code, "ENOBUFS");
  assert.equal(report.stdout.length, 65536);
  assert.ok(report.stdout.startsWith("ANR main thread "));
  assert.equal(
    r.calls.filter((c) => c === "shell dumpsys dropbox --print system_app_anr")
      .length,
    1,
  );
});

test("SurfaceFlinger backtrace refuses ambiguous process identity", async () => {
  for (const drift of ["final-anr-foreign-pid", "final-anr-foreign-exe"]) {
    const r = await simulate({ drift });
    assert.match(r.error.message, /Application ANR remains/);
    assert.ok(r.anrDiagnostics.guest.surfaceFlingerBacktrace.unavailable);
    assert.ok(!r.calls.some((c) => c.startsWith("shell debuggerd")));
  }
});

test("secure postrestart display refusal retains graphics evidence without admission or lock changes", async () => {
  const r = await simulate({ drift: "final-secure" });
  assert.equal(r.result.status, "FAIL");
  assert.match(r.error.message, /not observed awake/);
  assert.match(r.displayDiagnostics.guest.displayPolicy, /secure=true/);
  assert.match(
    r.displayDiagnostics.guest.surfaceFlingerBacktrace,
    /SurfaceFlinger main stack/,
  );
  assert.equal(r.anrDiagnostics, null);
  assert.equal(r.calls.filter((c) => c.startsWith("install ")).length, 1);
  const start = r.calls.indexOf("shell debuggerd -b 407");
  assert.ok(start > 0);
  assert.ok(
    !r.calls
      .slice(start)
      .some((c) =>
        /^(install |reboot$|remount$|shell (stop$|start$|input |wm dismiss|locksettings set))/.test(
          c,
        ),
      ),
  );
  assert.equal((await simulate()).displayDiagnostics, null);
});

test("host policy is explicit and captured independently of later caller mutation", () => {
  for (const forbiddenPackagePrefixes of [
    undefined,
    [],
    [""],
    ["../outside"],
    ["com.example;command"],
  ])
    assert.throws(
      () => createHostedWebViewProvisioner({ forbiddenPackagePrefixes }),
      /Explicit host package exclusions required/,
    );
  const prefixes = ["com.example.consumer."];
  const provisioner = createHostedWebViewProvisioner({
    forbiddenPackagePrefixes: prefixes,
  });
  prefixes.length = 0;
  const run = (...args) =>
    args.join(" ") === "shell pm list packages"
      ? "package:com.example.consumer.host"
      : responses[args.join(" ")];
  assert.throws(
    () => provisioner.requireProviderFixture(run, env),
    /Not a fresh default/,
  );
});

test("acknowledgement, SDK and output configuration refuse before file or device effects", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "provider-config-"));
  try {
    const output = path.join(parent, "evidence");
    let effects = 0;
    const base = {
      environment: env,
      fixtureAcknowledgement: "api35-default-x86_64",
      sdkEnvironment: { ANDROID_HOME: "/sdk" },
      outputDirectory: output,
      execute: () => {
        effects++;
        throw Error("must not execute");
      },
    };
    for (const overrides of [
      { fixtureAcknowledgement: undefined },
      { sdkEnvironment: undefined },
      { sdkEnvironment: { ANDROID_HOME: "relative" } },
      { outputDirectory: undefined },
      { outputDirectory: "relative" },
    ])
      await assert.rejects(main({ ...base, ...overrides }), /Explicit/);
    assert.equal(effects, 0);
    assert.equal(fs.existsSync(output), false);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});
