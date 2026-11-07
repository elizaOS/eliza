// Development snapshot provisioning for a fresh, disposable GitHub-hosted AOSP
// fixture only. This is not a production provider or a retail-device installer.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertFixtureIdentity,
  requireFixtureDisplay,
  requireHostedFixtureEnvironment,
} from "./ci-emulator-display.mjs";
import { prepareFixtureNetwork } from "./ci-emulator-network.mjs";
import { readBootDeviceIdentity } from "./ci-webview-boot-device.mjs";
import { HostedFixtureError } from "./errors.mjs";

export const candidate = Object.freeze({
  url: "https://commondatastorage.googleapis.com/chromium-browser-snapshots/AndroidDesktop_x64/1709176/chrome-android-desktop.zip?generation=1790879561205229",
  source: "b1bde56dbc71dd73916cb44c9270c37086379bdf",
  size: 495801966,
  archiveSha256:
    "77405c260640243a0f741f0419fe8b19dc1b798f2954fefddf64dfe23e2da1fc",
  apkSha256: "1fc4f0dbcd52fb6f1141f56df0ec31927e1e0a54d927da70023d4961eebf47ed",
  certificateSha256:
    "32a2fc74d731105859e5a85df16d95f102d85b22099b8064c5d8915c61dad1e0",
  version: "157.0.8083.0",
  versionCode: "808300007",
  package: "com.android.webview",
});
const require = (condition, message) => {
  if (!condition) throw new HostedFixtureError(message);
};
const sha = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
/** Bind the host's system-package exclusions before any fixture access. */
export function createHostedWebViewProvisioner({
  forbiddenPackagePrefixes,
} = {}) {
  require(Array.isArray(forbiddenPackagePrefixes) &&
    forbiddenPackagePrefixes.length > 0 &&
    forbiddenPackagePrefixes.every(
      (value) =>
        typeof value === "string" &&
        /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*\.?$/.test(value),
    ), "Explicit host package exclusions required");
  const exclusions = Object.freeze([...forbiddenPackagePrefixes]);
  // Exit 255 with a partial process dump is an unavailable observation, never
  // proof of no instrumentation. Retry only that failure; refresh every read-only
  // identity/package check each time. command() retains all failed observations.
  function requireProviderFixture(
    run,
    env,
    options = {},
    wait = () =>
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250),
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return providerFixtureAttempt(run, env, options);
      } catch (error) {
        if (
          !error.providerInventoryUnavailable ||
          error.status !== 255 ||
          error.signal != null ||
          attempt === 2
        )
          throw error;
        wait();
      }
    }
  }
  function providerFixtureAttempt(run, env, { installed = false } = {}) {
    requireHostedFixtureEnvironment(env, env.ANDROID_SERIAL);
    assertFixtureIdentity(run);
    for (const [key, value] of [
      ["ro.build.version.sdk", "35"],
      ["ro.product.cpu.abi", "x86_64"],
    ])
      require(run("shell", "getprop", key).trim() ===
        value, `Wrong provider fixture ${key}`);
    require(/^sdk_phone(?:64)?_x86_64-userdebug$/.test(
      run("shell", "getprop", "ro.build.flavor").trim(),
    ), "Wrong AOSP system image flavor");
    const packages = run("shell", "pm", "list", "packages", "-3")
      .trim()
      .split(/\r?\n/)
      .filter(Boolean);
    require(packages.every(
      (p) => installed && p === "package:com.android.webview",
    ), "Unexpected fixture applications");
    const all = run("shell", "pm", "list", "packages");
    require(!/package:(?:com\.google\.android\.(?:gms|webview)|com\.android\.chrome)/.test(
      all,
    ) &&
      !exclusions.some((prefix) =>
        all.includes(`package:${prefix}`),
      ), "Not a fresh default AOSP provider fixture");
    let processes;
    try {
      processes = run("shell", "dumpsys", "activity", "processes");
    } catch (error) {
      error.providerInventoryUnavailable = true;
      throw error;
    }
    require(processes.includes("ACTIVITY MANAGER") &&
      !/ActiveInstrumentation\{|InstrumentationRecord\{|mInstr=(?!null\b)/.test(
        processes,
      ), "Active or unknown instrumentation");
  }
  function stockPath(paths, dump) {
    const entries = paths.trim().split(/\r?\n/);
    require(entries.length === 1 &&
      /^package:\/product\/app\/webview\/[A-Za-z0-9_.-]+\.apk$/.test(
        entries[0],
      ), "Unexpected stock provider path");
    require(/\bversionName=124\.0\.6367\.219\b/.test(dump) &&
      !dump.includes(
        "UPDATED_SYSTEM_APP",
      ), "Unexpected stock provider identity");
    return entries[0].slice(8);
  }
  function verifyMetadata(signature, badging, manifest) {
    require(signature.includes(
      "Verified using v2 scheme (APK Signature Scheme v2): true",
    ) &&
      signature.includes(
        `Signer #1 certificate SHA-256 digest: ${candidate.certificateSha256}`,
      ), "Unexpected developer signature");
    require(badging.includes(
      `package: name='${candidate.package}' versionCode='${candidate.versionCode}' versionName='${candidate.version}'`,
    ) &&
      badging.includes("sdkVersion:'29'") &&
      badging.includes("targetSdkVersion:'37'") &&
      /native-code:.*'x86_64'/.test(badging), "Unexpected provider metadata");
    require(manifest.includes("com.android.webview.WebViewLibrary") &&
      manifest.includes("libwebviewchromium.so") &&
      !manifest.includes(
        "E: uses-static-library",
      ), "Unexpected external provider dependency");
  }

  // Device-mapper indices vary across boots; resolve only the named scratch device.
  function scratchBackingBytes(run, { requireDataBacking = false } = {}) {
    const inventory = run("shell", "dmctl", "list", "devices");
    require(inventory.startsWith(
      "Available Device Mapper Devices:",
    ), "Unknown device-mapper inventory");
    const rows = inventory
      .split(/\r?\n/)
      .filter((line) => /^\s*scratch(?=\s|:|$)/.test(line));
    require(rows.length <= 1, "Ambiguous scratch mapping");
    if (!rows.length) return null;
    const match = /^scratch\s*:\s*(\d+):(\d+)\s*$/.exec(rows[0]);
    require(match, "Malformed scratch mapping");
    const sysPath = `/sys/dev/block/${match[1]}:${match[2]}`;
    require(run("shell", "cat", `${sysPath}/dm/name`).trim() ===
      "scratch", "Scratch mapping identity drift");
    if (requireDataBacking) {
      require(run("shell", "ls", "-1", `${sysPath}/slaves`).trim() ===
        "vdc", "Scratch is not on the proven userdata backing device");
    }
    const sectors = run("shell", "cat", `${sysPath}/size`).trim();
    require(/^[0-9]+$/.test(sectors) &&
      Number.isSafeInteger(Number(sectors) * 512), "Unknown scratch size");
    return Number(sectors) * 512;
  }

  // This pinned SDK emulator can request the same overlay reboot again. Admit
  // that case only after proving the live product overlay in both shell and init
  // namespaces, its bounded scratch backing, and an owned reversible write.
  function proveLiveProductOverlay(run, admit, probeId = randomUUID()) {
    admit();
    require(run("shell", "getprop", "ro.build.fingerprint").trim() ===
      "Android/sdk_phone64_x86_64/emu64x:15/AE3A.240806.019/12368160:userdebug/test-keys", "Unreviewed overlay image");
    const devices = run("shell", "dmctl", "list", "devices");
    require(devices.startsWith("Available Device Mapper Devices:") &&
      !/^\s*\S+-verity\s*:/m.test(
        devices,
      ), "Active or unknown verity mappings");
    require(scratchBackingBytes(run, { requireDataBacking: true }) ===
      512 * 1024 * 1024, "Unexpected live scratch backing");
    for (const location of ["/proc/mounts", "/proc/1/mounts"]) {
      const rows = run("shell", "cat", location)
        .trim()
        .split(/\r?\n/)
        .map((line) => line.split(/\s+/));
      const product = rows.filter((row) => row[1] === "/product").at(-1);
      const options = new Set(product?.[3]?.split(",") ?? []);
      require(product?.[2] === "overlay" &&
        options.has("rw") &&
        !options.has("ro") &&
        options.has("lowerdir=/product") &&
        options.has("upperdir=/mnt/scratch/overlay/product/upper") &&
        options.has(
          "workdir=/mnt/scratch/overlay/product/work",
        ), `Product overlay is not writable in ${location}`);
      const scratch = rows.filter((row) => row[1] === "/mnt/scratch").at(-1);
      require(/^\/dev\/block\/dm-\d+$/.test(scratch?.[0] ?? "") &&
        ["f2fs", "ext4"].includes(scratch?.[2]) &&
        scratch[3].split(",").includes("rw") &&
        !scratch[3].split(",").includes("ro"), "Scratch mount unavailable");
      require(run(
        "shell",
        "cat",
        `/sys/class/block/${path.basename(scratch[0])}/dm/name`,
      ).trim() === "scratch", "Scratch mount identity drift");
    }
    require(/^[0-9a-f-]{36}$/.test(probeId), "Invalid overlay probe identity");
    const probe = `/product/app/webview/.eliza-ci-probe-${probeId}`;
    const marker = `eliza-ci-overlay-${probeId}`;
    admit();
    run("shell", "test", "!", "-e", probe);
    run("shell", "test", "!", "-L", probe);
    run("shell", `set -C; printf %s ${marker} > ${probe}`);
    // Never remove a preexisting or changed file. Failure leaves this disposable
    // fixture rejected, before any provider file is removed.
    require(run("shell", "cat", probe).trim() ===
      marker, "Overlay write probe mismatch");
    admit();
    run("shell", "rm", probe);
    run("shell", "test", "!", "-e", probe);
    return {
      namespaces: ["shell", "init"],
      scratchBytes: 512 * 1024 * 1024,
      writeProbeRemoved: true,
    };
  }

  // Verify the alias created by boot-time device discovery; never create it late.
  function ensureScratchBackingAlias(run, admit) {
    admit();
    require(run("shell", "getprop", "ro.build.fingerprint").trim() ===
      "Android/sdk_phone64_x86_64/emu64x:15/AE3A.240806.019/12368160:userdebug/test-keys", "Unreviewed image for scratch backing alias repair");
    const mounts = run("shell", "cat", "/proc/mounts")
      .trim()
      .split(/\r?\n/)
      .map((line) => line.split(/\s+/))
      .filter((fields) => fields[1] === "/data");
    require(mounts.length === 1 &&
      mounts[0][2] === "ext4" &&
      /^\/dev\/block\/dm-[0-9]+$/.test(
        mounts[0][0],
      ), "Unexpected userdata mount");
    const device = path.basename(mounts[0][0]);
    require(run("shell", "cat", `/sys/class/block/${device}/dm/name`).trim() ===
      "userdata", "Mounted data is not the userdata mapper");
    require(run(
      "shell",
      "ls",
      "-1",
      `/sys/class/block/${device}/slaves`,
    ).trim() === "vdc", "Unexpected userdata backing devices");
    const physical = "/dev/block/vdc";
    const alias = "/dev/block/by-name/vdc";
    require(run("shell", "readlink", "-f", "/dev/block/by-name").trim() ===
      "/dev/block/by-name", "Unexpected backing alias directory");
    const sysDevice = run("shell", "cat", "/sys/class/block/vdc/dev").trim();
    const statDevice = run("shell", "stat", "-c", "%t:%T", physical).trim();
    require(/^\d+:\d+$/.test(sysDevice) &&
      /^[0-9a-f]+:[0-9a-f]+$/i.test(statDevice) &&
      statDevice
        .split(":")
        .map((value) => parseInt(value, 16))
        .join(":") === sysDevice, "Backing block node identity mismatch");
    run("shell", "test", "-b", physical);
    const inspect = () =>
      run(
        "shell",
        "sh",
        "-c",
        "'if [ -L /dev/block/by-name/vdc ]; then readlink /dev/block/by-name/vdc; elif [ -e /dev/block/by-name/vdc ]; then echo NON_SYMLINK; else echo MISSING; fi'",
      ).trim();
    const previous = inspect();
    require(previous ===
      physical, "Missing or conflicting boot-time scratch backing alias");
    require(inspect() === physical &&
      run("shell", "readlink", "-f", alias).trim() ===
        physical, "Scratch backing alias did not resolve to the proven userdata backing device");
    return {
      image: "AE3A.240806.019/12368160",
      userdataMapper: device,
      backingDevice: physical,
      deviceNumber: sysDevice,
      alias,
      created: false,
    };
  }

  // Read-only diagnostic evidence: one shared budget, no retries, mutations or guessed block targets.
  function collectOverlayFailureDiagnostics({
    environment,
    sdkEnvironment,
    execute,
    now = Date.now,
    hostPaths = {
      workspace: process.cwd(),
      androidSdk: sdkEnvironment.ANDROID_HOME,
      home: process.env.HOME,
    },
    statfs = fs.statfsSync,
    userspaceOnly = false,
    stockBackup,
    providerRestart,
    superLayout = false,
    frameworkAnr = false,
  }) {
    const deadline = now() + 20000;
    const evidence = { host: {}, guest: {}, budgetMilliseconds: 20000 };
    for (const [name, location] of Object.entries(hostPaths)) {
      try {
        const value = statfs(location);
        evidence.host[name] = {
          availableBytes: value.bavail * value.bsize,
          freeBytes: value.bfree * value.bsize,
        };
      } catch (error) {
        evidence.host[name] = {
          unavailable: String(error.message).slice(0, 512),
        };
      }
    }
    if (stockBackup) {
      try {
        evidence.host.partialBackupBytes = fs.statSync(stockBackup.backup).size;
      } catch (error) {
        evidence.host.partialBackup = {
          unavailable: String(error.message).slice(0, 512),
        };
      }
    }
    let sourceFd;
    try {
      const source = path.join(
        sdkEnvironment.ANDROID_HOME,
        "system-images/android-35/default/x86_64/source.properties",
      );
      sourceFd = fs.openSync(source, "r");
      const bytes = Buffer.alloc(8192);
      evidence.host.imageSourceProperties = bytes
        .subarray(0, fs.readSync(sourceFd, bytes, 0, bytes.length, 0))
        .toString("utf8");
    } catch (error) {
      evidence.host.imageSourceProperties = {
        unavailable: String(error.message).slice(0, 512),
      };
    } finally {
      if (sourceFd !== undefined) fs.closeSync(sourceFd);
    }
    const read = (...args) => {
      const remaining = deadline - now();
      require(remaining > 0, "Failure diagnostic deadline exceeded");
      return execute(
        path.join(sdkEnvironment.ANDROID_HOME, "platform-tools/adb"),
        ["-s", environment.ANDROID_SERIAL, ...args],
        {
          env: sdkEnvironment,
          encoding: "utf8",
          timeout: Math.min(2000, remaining),
          maxBuffer: 256 * 1024,
        },
      );
    };
    const superReads = [
      ["superPartition", ["shell", "getprop", "ro.boot.super_partition"]],
      ["superAlias", ["shell", "readlink", "-f", "/dev/block/by-name/super"]],
      [
        "superLabels",
        [
          "shell",
          "ls",
          "-lZ",
          "/dev/block/vda",
          "/dev/block/vda2",
          "/dev/block/by-name/super",
        ],
      ],
      ["superUevent", ["shell", "cat", "/sys/class/block/vda2/uevent"]],
      [
        "superSlot0",
        ["shell", "lpdump", "--slot=0", "/dev/block/by-name/super"],
      ],
      [
        "superSlot1",
        ["shell", "lpdump", "--slot=1", "/dev/block/by-name/super"],
      ],
      [
        "vendorBlockContexts",
        [
          "shell",
          "grep",
          "-e",
          "super",
          "-e",
          "vda",
          "-e",
          "vd_device",
          "/vendor/etc/selinux/vendor_file_contexts",
        ],
      ],
    ];
    const reads = frameworkAnr
      ? [
          // Keep the report header and first thread stacks even if the retained dump is large.
          ["displayPolicy", ["shell", "dumpsys", "window", "policy"]],
          ["powerState", ["shell", "dumpsys", "power"]],
          ["surfaceFlingerBacktrace", null],
          [
            "graphicsLog",
            [
              "shell",
              "logcat",
              "-d",
              "-b",
              "main",
              "-t",
              "1000",
              "SurfaceFlinger:I",
              "RenderEngine:I",
              "EGL_emulation:I",
              "goldfish-address-space:I",
              "*:S",
            ],
          ],
          [
            "systemAppAnr",
            ["shell", "dumpsys", "dropbox", "--print", "system_app_anr"],
          ],
          ["lastAnr", ["shell", "dumpsys", "activity", "lastanr"]],
          ["processes", ["shell", "dumpsys", "activity", "processes"]],
          [
            "anrEvents",
            [
              "shell",
              "logcat",
              "-d",
              "-b",
              "events",
              "-t",
              "400",
              "am_anr:I",
              "am_crash:I",
              "*:S",
            ],
          ],
          ["systemLog", ["shell", "logcat", "-d", "-b", "system", "-t", "400"]],
          ["memory", ["shell", "cat", "/proc/meminfo"]],
          [
            "pressure",
            [
              "shell",
              "cat",
              "/proc/pressure/memory",
              "/proc/pressure/cpu",
              "/proc/pressure/io",
            ],
          ],
        ]
      : superLayout
        ? superReads
        : providerRestart
          ? [
              ...superReads,
              ["deviceMapperNames", ["shell", "dmctl", "list", "devices"]],
              ["mounts", ["shell", "cat", "/proc/mounts"]],
              [
                "scratchMetadata",
                ["shell", "lpdump", "/metadata/gsi/remount/lp_metadata"],
              ],
              [
                "userspaceStorageLog",
                ["shell", "logcat", "-d", "-b", "all", "-t", "400"],
              ],
              [
                "capacity",
                ["shell", "df", "-k", "/data", "/metadata", "/product"],
              ],
              [
                "stockStat",
                ["shell", "stat", "-c", "%s", providerRestart.stock],
              ],
              ["providerPath", ["shell", "pm", "path", candidate.package]],
              ["providerState", ["shell", "dumpsys", "webviewupdate"]],
              ["kernel", ["shell", "dmesg"]],
            ]
          : stockBackup
            ? [
                ["adbVersion", ["version"]],
                ["deviceState", ["get-state"]],
                ["fingerprint", ["shell", "getprop", "ro.build.fingerprint"]],
                ["stockStat", ["shell", "stat", "-c", "%s", stockBackup.stock]],
                [
                  "capacity",
                  ["shell", "df", "-k", "/data", "/metadata", "/product"],
                ],
              ]
            : [
                [
                  "userspaceStorageLog",
                  ["shell", "logcat", "-d", "-b", "all", "-t", "400"],
                ],
                ["fingerprint", ["shell", "getprop", "ro.build.fingerprint"]],
                ["deviceMapperNames", ["shell", "dmctl", "list", "devices"]],
                ["blockNames", ["shell", "ls", "-l", "/dev/block/by-name"]],
                [
                  "superMetadata",
                  ["shell", "lpdump", "/dev/block/by-name/super"],
                ],
                [
                  "capacity",
                  ["shell", "df", "-k", "/data", "/metadata", "/product"],
                ],
                ["partitions", ["shell", "cat", "/proc/partitions"]],
                ["kernel", ["shell", "dmesg"]],
              ];
    for (const [name, args] of reads) {
      if (userspaceOnly && name !== "userspaceStorageLog") continue;
      // Admission uses the same bounded executor and performs one complete attempt.
      try {
        requireProviderFixture(
          read,
          environment,
          { installed: Boolean(providerRestart || frameworkAnr) },
          () => {
            throw new HostedFixtureError(
              "Failure diagnostic admission unavailable",
            );
          },
        );
      } catch (error) {
        evidence.admissionStopped = String(error.message).slice(0, 512);
        break;
      }
      try {
        let result;
        if (name === "surfaceFlingerBacktrace") {
          const pid = read("shell", "pidof", "surfaceflinger").trim();
          require(/^[1-9][0-9]{0,9}$/.test(
            pid,
          ), "Expected one SurfaceFlinger PID");
          require(read("shell", "readlink", "-f", `/proc/${pid}/exe`).trim() ===
            "/system/bin/surfaceflinger", "SurfaceFlinger executable changed");
          result = read("shell", "debuggerd", "-b", pid);
        } else result = read(...args);
        evidence.guest[name] = [
          "systemAppAnr",
          "surfaceFlingerBacktrace",
        ].includes(name)
          ? result.slice(0, 65536)
          : (["userspaceStorageLog", "kernel"].includes(name)
              ? result
                  .split("\n")
                  .filter((line) =>
                    /gsid|fiemap|scratch|overlay|mkfs|f2fs|ext4|device.mapper/i.test(
                      line,
                    ),
                  )
                  .join("\n")
              : result
            ).slice(-65536);
      } catch (error) {
        evidence.guest[name] = {
          unavailable: String(error.message).slice(0, 512),
          status: error.status ?? null,
          signal: error.signal ?? null,
          code: error.code ?? null,
          stdout: ["systemAppAnr", "surfaceFlingerBacktrace"].includes(name)
            ? String(error.stdout ?? "").slice(0, 65536)
            : String(error.stdout ?? "").slice(-4096),
          stderr: String(error.stderr ?? "").slice(-4096),
        };
      }
    }
    return evidence;
  }

  async function main({
    environment = process.env,
    execute = execFileSync,
    executeRemount = spawnSync,
    sdkEnvironment,
    outputDirectory,
    fixtureAcknowledgement,
    sleep = (milliseconds) =>
      new Promise((resolve) => setTimeout(resolve, milliseconds)),
    now = Date.now,
    fileDigest = sha,
  } = {}) {
    const serial = environment.ANDROID_SERIAL;
    requireHostedFixtureEnvironment(environment, serial); // Before download or device access.
    require(fixtureAcknowledgement ===
      "api35-default-x86_64", "Explicit disposable provider fixture required");
    require(typeof sdkEnvironment?.ANDROID_HOME === "string" &&
      path.isAbsolute(
        sdkEnvironment.ANDROID_HOME,
      ), "Explicit Android SDK environment required");
    require(typeof outputDirectory === "string" &&
      path.isAbsolute(
        outputDirectory,
      ), "Explicit absolute evidence directory required");
    const env = sdkEnvironment,
      sdk = env.ANDROID_HOME;
    const output = path.resolve(outputDirectory);
    require(!fs.existsSync(
      output,
    ), "Fresh provider evidence directory required");
    fs.mkdirSync(output, { recursive: true });
    const state = {
      status: "preflight",
      candidate,
      productionApproved: false,
      runtimeFeaturesQualified: false,
      commands: [],
    };
    const save = () =>
      fs.writeFileSync(
        path.join(output, "result.json"),
        `${JSON.stringify(state, null, 2)}\n`,
      );
    const command = (file, args, timeout = 20000) => {
      const started = now();
      try {
        const options = {
          env,
          encoding: "utf8",
          timeout,
          maxBuffer: 16 * 1024 * 1024,
        };
        let result;
        if (args.length === 3 && args[2] === "remount") {
          // adb remount reports its result on stderr on this API35 image.
          // Capture both channels only here; preserve transport failures.
          const captured = executeRemount(file, args, options);
          if (captured.error || captured.status !== 0 || captured.signal) {
            const error =
              captured.error || new HostedFixtureError("adb remount failed");
            Object.assign(error, {
              status: captured.status,
              signal: captured.signal,
              stdout: captured.stdout,
              stderr: captured.stderr,
            });
            throw error;
          }
          result = [captured.stdout, captured.stderr]
            .filter((value) => value)
            .join("\n");
        } else result = execute(file, args, options);
        state.commands.push({ file, args, success: true });
        save();
        return result;
      } catch (error) {
        state.commands.push({
          file,
          args,
          durationMilliseconds: Math.max(0, now() - started),
          success: false,
          status: error.status ?? null,
          signal: error.signal ?? null,
          code: error.code ?? null,
          stdout: String(error.stdout ?? "").slice(-65536),
          stderr: String(error.stderr ?? "").slice(-65536),
        });
        save();
        throw error;
      }
    };
    const run = (...args) =>
      command(path.join(sdk, "platform-tools/adb"), ["-s", serial, ...args]);
    const safe = (installed = false) =>
      requireProviderFixture(run, environment, { installed });
    const rootFixture = () => {
      safe();
      const bootId = run(
        "shell",
        "cat",
        "/proc/sys/kernel/random/boot_id",
      ).trim();
      require(/^[a-f0-9-]{36}$/.test(bootId), "Invalid pre-root boot identity");
      let disconnected;
      try {
        run("root");
      } catch (error) {
        // adbd may close this request while restarting. Never replay the mutation:
        // require fresh fixture identity and actual privilege readback instead.
        if (
          error.status !== 1 ||
          error.signal != null ||
          String(error.stderr ?? "").trim() !==
            "adb: unable to connect for root: closed"
        )
          throw error;
        disconnected = error;
      }
      try {
        run("wait-for-device");
        safe();
        require(run(
          "shell",
          "cat",
          "/proc/sys/kernel/random/boot_id",
        ).trim() === bootId, "Provider fixture restarted during root request");
        require(run("shell", "id", "-u").trim() ===
          "0", "Provider fixture root was not established");
      } catch (error) {
        throw disconnected ?? error;
      }
      if (disconnected) {
        state.rootDisconnectReconciled = true;
        save();
      }
    };
    const bootIdentity = (installed = false) => {
      safe(installed);
      const deadline = now() + 15000;
      const observations = readBootDeviceIdentity(
        (...args) => {
          const remaining = deadline - now();
          require(remaining > 0, "Boot-device readback deadline exceeded");
          return command(
            path.join(sdk, "platform-tools/adb"),
            ["-s", serial, ...args],
            Math.min(2000, remaining),
          );
        },
        (readback) => {
          state.bootDeviceReadbacks ??= [];
          state.bootDeviceReadbacks.push(readback);
          save();
        },
      );
      state.bootDeviceAdmissions ??= [];
      state.bootDeviceAdmissions.push(observations);
      save();
    };
    const scratchProperty = "fs_mgr.overlayfs.data_scratch_size_mb";
    const configureScratch = () => {
      bootIdentity(); // Require persistent boot-time identity after every reboot.
      safe(); // Every property mutation is confined to the fresh hosted fixture.
      if (!state.scratchBackingAliases) {
        require(scratchBackingBytes(run) ===
          null, "Existing scratch requires a fresh disposable fixture");
      }
      state.scratchBackingAliases ??= [];
      state.scratchBackingAliases.push(ensureScratchBackingAlias(run, safe));
      save();
      const previous = run("shell", "getprop", scratchProperty).trim();
      require(previous === "" ||
        previous === "512", "Unexpected existing scratch size policy");
      run("shell", "setprop", scratchProperty, "512");
      require(run("shell", "getprop", scratchProperty).trim() ===
        "512", "Scratch size policy did not apply");
      state.scratchPolicy = {
        property: scratchProperty,
        previous,
        megabytes: 512,
      };
      save();
    };
    const captureStorage = (label) => {
      const details = {};
      // Fixed read-only commands; never run a formatter or infer a target dm-N device.
      for (const [name, args] of [
        ["capacity", ["shell", "df", "-k", "/data", "/metadata", "/product"]],
        ["mounts", ["shell", "cat", "/proc/mounts"]],
        ["partitions", ["shell", "cat", "/proc/partitions"]],
        ["logicalPartitions", ["shell", "lpdump"]],
        ["kernel", ["shell", "dmesg"]],
      ]) {
        try {
          const value = run(...args);
          details[name] = (
            name === "kernel"
              ? value
                  .split("\n")
                  .filter((line) =>
                    /fiemap|f2fs|ext4|device.mapper|dm-|scratch|overlay|gsid/i.test(
                      line,
                    ),
                  )
                  .join("\n")
              : value
          ).slice(-65536);
        } catch (error) {
          details[name] = { unavailable: error.message.slice(0, 512) };
        }
      }
      fs.writeFileSync(
        path.join(output, `storage-${label}.json`),
        `${JSON.stringify(details, null, 2)}\n`,
      );
    };
    const serverIdentity = (read = run) => {
      const pid = read("shell", "pidof", "system_server").trim();
      require(/^[1-9][0-9]*$/.test(pid), "Expected one system_server process");
      const stat = read("shell", "cat", `/proc/${pid}/stat`).trim();
      const match = stat.match(/^([1-9][0-9]*) \(system_server\) ([^\n]+)$/);
      const fields = match?.[2].split(/\s+/);
      require(match?.[1] === pid &&
        fields?.length >= 20 &&
        /^[0-9]+$/.test(fields[19]), "Unknown system_server process identity");
      return { pid, startTicks: fields[19] };
    };
    const sameServer = (a, b) =>
      a.pid === b.pid && a.startTicks === b.startTicks;
    const boot = async (previousServer = null, installed = false) => {
      const end = now() + 180000;
      let rootRequested = false;
      const read = (...args) => {
        const remaining = end - now();
        require(remaining > 0, "Provider fixture boot deadline exceeded");
        return command(
          path.join(sdk, "platform-tools/adb"),
          ["-s", serial, ...args],
          Math.min(2000, remaining),
        );
      };
      while (now() < end) {
        try {
          if (
            read("shell", "getprop", "sys.boot_completed").trim() === "1" &&
            /Service package: found/.test(
              read("shell", "service", "check", "package"),
            ) &&
            /Service activity: found/.test(
              read("shell", "service", "check", "activity"),
            ) &&
            read(
              "shell",
              "cmd",
              "activity",
              "get-started-user-state",
              "0",
            ).trim() === "RUNNING_UNLOCKED"
          ) {
            // Reboot drops adbd privileges. Authenticate the complete disposable
            // fixture before restoring root; never assume shell can inspect /proc.
            const uid = read("shell", "id", "-u").trim();
            if (uid !== "0") {
              if (!rootRequested) {
                try {
                  require(uid ===
                    "2000", "Unexpected provider fixture shell identity");
                  requireProviderFixture(read, environment, { installed });
                } catch (error) {
                  error.providerFixtureRefusal = true;
                  throw error;
                }
                rootRequested = true; // An ambiguous or refused root request is never replayed.
                read("root");
                read("wait-for-device");
              }
              await sleep(1000);
              continue;
            }
            const before = serverIdentity(read);
            const processes = read(
              "shell",
              "dumpsys",
              "activity",
              "-a",
              "processes",
            );
            const after = serverIdentity(read);
            const rows = processes
              .split(/\r?\n/)
              .filter((line) => /\bmSystemReady=/.test(line));
            const ready =
              rows.length === 1 &&
              /^\s*mProcessesReady=true mSystemReady=true mBooted=true mFactoryTest=[0-9]+\s*$/.test(
                rows[0],
              );
            state.lastFrameworkReadiness = {
              before,
              after,
              previousServer,
              ready,
              row: rows.join("\n").slice(0, 512),
            };
            save();
            if (
              ready &&
              sameServer(before, after) &&
              (!previousServer || !sameServer(previousServer, after))
            ) {
              state.frameworkAdmissions ??= [];
              state.frameworkAdmissions.push(state.lastFrameworkReadiness);
              save();
              return after;
            }
          }
        } catch (error) {
          if (error.providerFixtureRefusal) throw error;
          // Offline, incomplete framework initialization and binder replacement
          // are read-only readiness failures; never retry provider installation.
          state.lastBootReadError = error.message;
        }
        await sleep(1000);
      }
      throw new HostedFixtureError("Provider fixture boot deadline exceeded");
    };
    save();
    try {
      // Shell cannot read /proc/bootconfig. Full boot admission follows the
      // existing adb-root step in configureScratch, before any overlay mutation.
      safe();
      const stock = stockPath(
        run("shell", "pm", "path", candidate.package),
        run("shell", "dumpsys", "package", candidate.package),
      );
      const stockHash = run("shell", "sha256sum", stock).trim().split(/\s+/)[0];
      require(/^[a-f0-9]{64}$/.test(stockHash), "Invalid stock hash");
      const backup = path.join(output, "stock-webview.apk");
      state.stock = { path: stock, sha256: stockHash };
      save();
      try {
        run("pull", stock, backup);
        require(fileDigest(backup) === stockHash, "Stock backup mismatch");
      } catch (error) {
        try {
          const diagnostics = collectOverlayFailureDiagnostics({
            environment,
            sdkEnvironment: env,
            execute,
            now,
            stockBackup: { stock, backup },
          });
          fs.writeFileSync(
            path.join(output, "stock-backup-failure-diagnostics.json"),
            `${JSON.stringify(diagnostics, null, 2)}\n`,
          );
        } catch (diagnosticError) {
          state.diagnosticError = String(diagnosticError.message).slice(0, 512);
        }
        throw error;
      }
      const archive = path.join(output, "chromium.zip"),
        apk = path.join(output, "SystemWebView.apk");
      command(
        "curl",
        [
          "--fail",
          "--location",
          "--silent",
          "--show-error",
          "--connect-timeout",
          "20",
          "--max-time",
          "600",
          candidate.url,
          "--output",
          archive,
        ],
        610000,
      );
      require(fs.statSync(archive).size === candidate.size &&
        fileDigest(archive) ===
          candidate.archiveSha256, "Official archive bytes changed");
      command("python3", [
        fileURLToPath(new URL("./extract-ci-webview.py", import.meta.url)),
        archive,
        apk,
      ]);
      require(fileDigest(apk) ===
        candidate.apkSha256, "Extracted APK bytes changed");
      const tools = path.join(sdk, "build-tools/36.0.0");
      const signature = command(path.join(tools, "apksigner"), [
        "verify",
        "--verbose",
        "--print-certs",
        apk,
      ]);
      const badging = command(path.join(tools, "aapt"), [
        "dump",
        "badging",
        apk,
      ]);
      const manifest = command(path.join(tools, "aapt"), [
        "dump",
        "xmltree",
        apk,
        "AndroidManifest.xml",
      ]);
      verifyMetadata(signature, badging, manifest);
      for (const [name, value] of Object.entries({
        signature,
        badging,
        manifest,
      }))
        fs.writeFileSync(path.join(output, `${name}.txt`), value);
      // Chromium's Q+ removal helper targets Google/Trichrome and Chrome. We do
      // not execute it: only the single verified AOSP file below may be removed.
      rootFixture();
      state.status = "preparing-overlay-storage";
      save();
      captureStorage("before");
      const superLayout = collectOverlayFailureDiagnostics({
        environment,
        sdkEnvironment: env,
        execute,
        now,
        superLayout: true,
      });
      fs.writeFileSync(
        path.join(output, "super-layout-before.json"),
        `${JSON.stringify(superLayout, null, 2)}\n`,
      );
      configureScratch();
      run("disable-verity");
      // disable-verity can report overlay failure with exit zero; retain its logs before reboot.
      try {
        const diagnostics = collectOverlayFailureDiagnostics({
          environment,
          sdkEnvironment: env,
          execute,
          now,
          userspaceOnly: true,
        });
        fs.writeFileSync(
          path.join(output, "overlay-pre-reboot-diagnostics.json"),
          `${JSON.stringify(diagnostics, null, 2)}\n`,
        );
      } catch (diagnosticError) {
        state.preRebootDiagnosticError = String(diagnosticError.message).slice(
          0,
          512,
        );
      }
      safe();
      run("reboot");
      run("wait-for-device");
      await boot();
      rootFixture();
      configureScratch(); // Non-persistent property is reset by reboot.
      let remount = run("remount");
      state.overlayRemountOutputs = [remount.slice(-65536)];
      save();
      const rebootNotice =
        /^Now reboot your device for settings to take effect\r?$/m;
      if (
        /^Remount succeeded\r?$/im.test(remount) &&
        rebootNotice.test(remount)
      ) {
        require(!/reboot/i.test(
          remount.replace(rebootNotice, ""),
        ), "Unrecognized remount reboot request");
        safe();
        require(scratchBackingBytes(run, { requireDataBacking: true }) ===
          512 *
            1024 *
            1024, "Expected 512MiB data scratch before overlay reboot");
        state.overlayRebootRequested = true;
        save();
        // Exactly one documented first-overlay activation reboot; never loop or ignore it.
        run("reboot");
        run("wait-for-device");
        await boot();
        rootFixture();
        configureScratch(); // Reauthenticate userdata alias and reset the volatile property.
        remount = run("remount");
        state.overlayRemountOutputs.push(remount.slice(-65536));
        save();
      }
      if (
        state.overlayRebootRequested &&
        rebootNotice.test(remount) &&
        remount.trim() === state.overlayRemountOutputs[0].trim()
      ) {
        // No further reboot: the existing stop/start below recreates framework
        // processes after the proven live overlay and exact provider replacement.
        state.liveOverlayProof = proveLiveProductOverlay(run, safe);
        save();
      }
      require(/^remount succeeded\r?$/im.test(remount) &&
        (!/reboot/i.test(remount) ||
          state.liveOverlayProof), "Remount requires manual review");
      safe();
      state.scratchBytes = scratchBackingBytes(run, {
        requireDataBacking: true,
      });
      require(state.scratchBytes ===
        512 * 1024 * 1024, "Expected 512MiB data scratch was not established");
      save();
      captureStorage("remounted");
      safe();
      require(stockPath(
        run("shell", "pm", "path", candidate.package),
        run("shell", "dumpsys", "package", candidate.package),
      ) === stock, "Stock path changed");
      require(run("shell", "sha256sum", stock).trim().split(/\s+/)[0] ===
        stockHash &&
        fileDigest(backup) === stockHash &&
        fileDigest(apk) ===
          candidate.apkSha256, "Provider bytes changed before removal");
      state.status = "removing-exact-stock-file";
      save();
      // Restart the Java framework only. Restarting SurfaceFlinger can strand
      // SystemUI in getGpuContextPriority on this emulator graphics backend.
      const previousServer = serverIdentity();
      run("shell", "stop", "zygote");
      try {
        require(run("emu", "avd", "name").trim().split(/\r?\n/)[0] === "test" &&
          run("shell", "getprop", "ro.kernel.qemu").trim() ===
            "1", "Fixture changed while stopped");
        require(run("shell", "sha256sum", stock).trim().split(/\s+/)[0] ===
          stockHash, "Stopped provider changed");
        run("shell", "rm", stock);
      } finally {
        run("shell", "start", "zygote");
      }
      const admittedServer = await boot(previousServer);
      safe();
      require(!run(
        "shell",
        "pm",
        "list",
        "packages",
        candidate.package,
      ).trim(), "Conflicting provider remains");
      require(sameServer(
        admittedServer,
        serverIdentity(),
      ), "Framework changed before provider installation");
      command(
        path.join(sdk, "platform-tools/adb"),
        ["-s", serial, "install", "--no-incremental", apk],
        120000,
      );
      safe(true);
      run(
        "shell",
        "cmd",
        "webviewupdate",
        "set-webview-implementation",
        candidate.package,
      );
      const qualifyInstalledProvider = async (label) => {
        const selectionDeadline = now() + 60000;
        let selected = "",
          ready = false;
        while (now() < selectionDeadline) {
          safe(true); // Drift is never treated as a transient readiness failure.
          selected = run("shell", "dumpsys", "webviewupdate");
          fs.writeFileSync(
            path.join(output, "provider-selected.txt"),
            selected,
          );
          const relro = [
            ...selected.matchAll(
              /Number of relros (?:started|finished): (\d+)/g,
            ),
          ].map((m) => Number(m[1]));
          ready =
            selected.includes(
              `Current WebView package (name, version): (${candidate.package}, ${candidate.version})`,
            ) &&
            selected.includes("WebView package dirty: false") &&
            /is\s+installed\/enabled for all users/.test(selected) &&
            relro.length === 2 &&
            relro[0] > 0 &&
            relro[0] === relro[1];
          if (ready) break;
          await sleep(500);
        }
        require(ready, "Provider selection/RELRO readiness deadline exceeded");
        const installed = run("shell", "pm", "path", candidate.package).trim();
        require(/^package:\/data\/app\/[A-Za-z0-9_./+=~-]+\.apk$/.test(
          installed,
        ), "Unexpected installed provider path");
        require(run("shell", "sha256sum", installed.slice(8))
          .trim()
          .split(/\s+/)[0] ===
          candidate.apkSha256, "Installed provider bytes changed");
        state.providerChecks ??= [];
        state.providerChecks.push({
          label,
          path: installed,
          apkSha256: candidate.apkSha256,
        });
        save();
      };
      await qualifyInstalledProvider("after-install");
      // The temporary provider-free framework may leave SystemUI unhealthy.
      // This emulator loses its scratch overlay across a kernel reboot. Finalize
      // successful replacement with one fresh framework generation after installation,
      // never as a response to a failed install or a failed security admission.
      safe(true);
      const priorBootId = run(
        "shell",
        "cat",
        "/proc/sys/kernel/random/boot_id",
      ).trim();
      require(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(
        priorBootId,
      ), "Unknown provider boot identity");
      const previousProviderServer = serverIdentity();
      const previousNetd = run("shell", "pidof", "netd").trim();
      require(/^[1-9][0-9]*$/.test(
        previousNetd,
      ), "Expected one fixture netd process");
      state.status = "finalizing-provider-framework";
      state.providerRestart = {
        priorBootId,
        previousServer: previousProviderServer,
        requested: true,
      };
      save();
      run("shell", "stop", "zygote");
      // netd retains network IDs and interface ownership across a zygote-only
      // restart. Reset the empty fixture's network daemon before the new framework
      // registers networks; otherwise DNS fails with ENONET despite a connected AP.
      run("shell", "stop", "netd");
      run("shell", "start", "netd");
      run("shell", "start", "zygote");
      state.providerRestart.server = await boot(previousProviderServer, true);
      save();
      safe(true);
      const netd = run("shell", "pidof", "netd").trim();
      require(/^[1-9][0-9]*$/.test(netd) &&
        netd !== previousNetd, "Fixture netd did not restart");
      state.providerRestart.netd = { before: previousNetd, after: netd };
      save();
      const bootId = run(
        "shell",
        "cat",
        "/proc/sys/kernel/random/boot_id",
      ).trim();
      require(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(bootId) &&
        bootId ===
          priorBootId, "Provider framework restart changed kernel boot identity");
      state.providerRestart.bootId = bootId;
      save();
      bootIdentity(true);
      state.providerRestart.backingAlias = ensureScratchBackingAlias(run, () =>
        safe(true),
      );
      save();
      state.providerRestart.scratchBytes = scratchBackingBytes(run, {
        requireDataBacking: true,
      });
      save();
      if (state.providerRestart.scratchBytes !== 512 * 1024 * 1024) {
        try {
          const diagnostics = collectOverlayFailureDiagnostics({
            environment,
            sdkEnvironment: env,
            execute,
            now,
            providerRestart: { stock },
          });
          fs.writeFileSync(
            path.join(output, "provider-restart-storage-diagnostics.json"),
            `${JSON.stringify(diagnostics, null, 2)}\n`,
          );
        } catch (diagnosticError) {
          state.providerRestart.diagnosticError = String(
            diagnosticError.message,
          ).slice(0, 512);
          save();
        }
      }
      require(state.providerRestart.scratchBytes ===
        512 * 1024 * 1024, "Provider restart lost authenticated data scratch");
      run("shell", "test", "!", "-e", stock);
      await qualifyInstalledProvider("after-framework-restart");
      state.providerDisplayObservations = [];
      try {
        await requireFixtureDisplay(run, {
          env: environment,
          serial,
          sleep,
          record: (observation) => {
            state.providerDisplayObservations.push(observation);
            save();
          },
        });
      } catch (displayError) {
        // Read-only evidence after refusal; never use diagnostics to admit a secure fixture.
        try {
          const diagnostics = collectOverlayFailureDiagnostics({
            environment,
            sdkEnvironment: env,
            execute,
            now,
            frameworkAnr: true,
          });
          fs.writeFileSync(
            path.join(output, "provider-framework-display.json"),
            `${JSON.stringify(diagnostics, null, 2)}\n`,
          );
        } catch (diagnosticError) {
          state.providerRestart.diagnosticError = String(
            diagnosticError.message,
          ).slice(0, 512);
          save();
        }
        throw displayError;
      }
      const activity = run("shell", "dumpsys", "activity", "activities");
      state.providerRestart.anrPresent = activity.includes(
        "Application Not Responding:",
      );
      state.providerRestart.anrLines = activity
        .split(/\r?\n/)
        .filter((line) => line.includes("Application Not Responding:"))
        .slice(0, 8)
        .map((line) => line.slice(0, 512));
      save();
      if (state.providerRestart.anrPresent) {
        // Fresh disposable emulator only, before any product app or credentials.
        // Preserve the failure; do not dismiss the dialog or restart a second time.
        try {
          const diagnostics = collectOverlayFailureDiagnostics({
            environment,
            sdkEnvironment: env,
            execute,
            now,
            frameworkAnr: true,
          });
          fs.writeFileSync(
            path.join(output, "provider-framework-anr.json"),
            `${JSON.stringify(diagnostics, null, 2)}\n`,
          );
        } catch (diagnosticError) {
          state.providerRestart.diagnosticError = String(
            diagnosticError.message,
          ).slice(0, 512);
          save();
        }
      }
      require(!state.providerRestart
        .anrPresent, "Application ANR remains after provider framework restart");
      state.networkObservations = [];
      await prepareFixtureNetwork(run, {
        env: environment,
        serial,
        sleep,
        record: (observation) => {
          state.networkObservations.push(observation);
          save();
        },
      });
      state.status = "PROVISIONED_RUNTIME_QUALIFICATION_PENDING";
      save();
      // APKs are reproducible via pinned URL/hash; keep compact provenance in CI artifacts.
      fs.unlinkSync(archive);
      fs.unlinkSync(apk);
    } catch (error) {
      if (state.status === "preparing-overlay-storage") {
        try {
          const diagnostics = collectOverlayFailureDiagnostics({
            environment,
            sdkEnvironment: env,
            execute,
            now,
          });
          fs.writeFileSync(
            path.join(output, "overlay-failure-diagnostics.json"),
            `${JSON.stringify(diagnostics, null, 2)}\n`,
          );
        } catch (diagnosticError) {
          state.diagnosticError = String(diagnosticError.message).slice(0, 512);
        }
      }
      state.failedAt = state.status;
      state.status = "FAIL";
      state.error = error.message;
      try {
        save();
      } catch {
        /* Evidence failure must not replace the original provisioning error. */
      }
      throw error;
    }
  }
  return {
    main,
    requireProviderFixture,
    stockPath,
    verifyMetadata,
    scratchBackingBytes,
    proveLiveProductOverlay,
    ensureScratchBackingAlias,
    collectOverlayFailureDiagnostics,
  };
}
