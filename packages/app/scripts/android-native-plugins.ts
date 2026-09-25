#!/usr/bin/env node
/** Compile and exercise every Android native module; skipped tests are not proof. */
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { acquireDeviceLease } from "./lib/device-lease.ts";

const root = path.resolve(import.meta.dirname, "../../..");

export function inventory(repoRoot = root) {
  return fs
    .readdirSync(path.join(repoRoot, "plugins"))
    .filter(
      (name) =>
        name.startsWith("plugin-native-") &&
        fs.existsSync(path.join(repoRoot, "plugins", name, "package.json")),
    )
    .sort()
    .map((directory) => {
      const dir = path.join(repoRoot, "plugins", directory);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(dir, "package.json"), "utf8"),
      );
      const android = fs.existsSync(path.join(dir, "android/build.gradle"));
      const testDir = path.join(dir, "android/src/androidTest");
      const tests = fs.existsSync(testDir)
        ? fs
            .readdirSync(testDir, { recursive: true })
            .filter((name) => /\.(kt|java)$/.test(name))
            .flatMap((name) => {
              const source = fs.readFileSync(path.join(testDir, name), "utf8");
              const count = [...source.matchAll(/@Test\b/g)].length;
              return count ? [{ file: name, count }] : [];
            })
        : [];
      return {
        directory,
        name: manifest.name,
        project: manifest.name.replace(/^@/, "").replaceAll("/", "-"),
        android,
        tests,
        expectedTests:
          tests.reduce((sum, test) => sum + test.count, 0) + (android ? 1 : 0),
      };
    });
}

export function parseInstrumentation(output, expectedTests) {
  const tests = [];
  let status = {};
  for (const line of output.split(/\r?\n/)) {
    const field = line.match(
      /^INSTRUMENTATION_STATUS: (class|test|stack)=(.*)$/,
    );
    if (field) status[field[1]] = field[2];
    const code = line.match(/^INSTRUMENTATION_STATUS_CODE: (-?\d+)$/);
    if (!code) continue;
    const value = Number(code[1]);
    if (value !== 1 && status.class && status.test) {
      tests.push({
        ...status,
        code: value,
        status:
          value === 0
            ? "passed"
            : value === -3 || value === -4
              ? "skipped"
              : "failed",
      });
    }
    status = {};
  }
  const problems = [];
  if (
    !/^INSTRUMENTATION_CODE: -1\s*$/m.test(output) ||
    /INSTRUMENTATION_FAILED|FAILURES!!!|INSTRUMENTATION_RESULT: shortMsg=/.test(
      output,
    )
  )
    problems.push("instrumentation did not complete successfully");
  if (tests.length !== expectedTests || expectedTests < 1)
    problems.push(`executed ${tests.length} tests; expected ${expectedTests}`);
  if (
    new Set(tests.map((test) => `${test.class}#${test.test}`)).size !==
    tests.length
  )
    problems.push("duplicate test results");
  for (const test of tests)
    if (test.status !== "passed")
      problems.push(`${test.class}#${test.test}: ${test.status}`);
  return { pass: problems.length === 0, tests, problems };
}

/** Device tests may export small, complete media artifacts in instrumentation status bundles. */
export function parseNativeArtifacts(output) {
  const artifacts = [];
  const names = new Set();
  let fields = {};
  for (const line of output.split(/\r?\n/)) {
    const field = line.match(
      /^INSTRUMENTATION_STATUS: nativeArtifact(Name|Base64)=(.*)$/,
    );
    if (field) {
      if (Object.hasOwn(fields, field[1]))
        throw new Error("Duplicate native artifact field");
      fields[field[1]] = field[2];
    }
    if (!/^INSTRUMENTATION_STATUS_CODE:/.test(line)) continue;
    if (Object.keys(fields).length) {
      if (
        line !== "INSTRUMENTATION_STATUS_CODE: 2" ||
        !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpg|mp4|wav|json|txt)$/.test(
          fields.Name ?? "",
        ) ||
        names.has(fields.Name) ||
        typeof fields.Base64 !== "string" ||
        !fields.Base64
      ) {
        throw new Error("Invalid or duplicate native artifact status");
      }
      const bytes = Buffer.from(fields.Base64, "base64");
      if (bytes.toString("base64") !== fields.Base64)
        throw new Error(`Invalid base64 for native artifact ${fields.Name}`);
      names.add(fields.Name);
      artifacts.push({ name: fields.Name, bytes });
    }
    fields = {};
  }
  if (Object.keys(fields).length)
    throw new Error("Incomplete native artifact status");
  return artifacts;
}

function restoreMobileSignalsScreen(adb, outputDir) {
  // Also recover screen state if instrumentation crashed mid-transition.
  adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
  adb("shell", "wm", "dismiss-keyguard");
  const deadline = Date.now() + 5_000;
  while (!/\bmWakefulness=Awake\b/.test(adb("shell", "dumpsys", "power"))) {
    if (Date.now() >= deadline)
      throw new Error("Emulator did not return to awake state");
  }
  fs.writeFileSync(
    path.join(outputDir, "mobile-signals-host-cleanup.json"),
    JSON.stringify({ awake: true, observedBy: "dumpsys power" }),
  );
}

async function main() {
  const args = process.argv.slice(2);
  const value = (flag) => args[args.indexOf(flag) + 1];
  const plugins = inventory();
  if (args.includes("--list")) {
    console.log(JSON.stringify(plugins, null, 2));
    return;
  }
  const serial = args.includes("--serial")
    ? value("--serial")
    : process.env.ANDROID_SERIAL;
  if (!serial || serial.startsWith("--"))
    throw new Error(
      "Choose an emulator explicitly with --serial <adb serial> (or ANDROID_SERIAL).",
    );
  const selected = plugins.filter(
    (plugin) =>
      plugin.android &&
      (!args.includes("--plugin") || plugin.directory === value("--plugin")),
  );
  if (!selected.length) throw new Error("No matching Android plugins");
  const outputDir = testOutputPath(
    "android-native-plugins",
    new Date().toISOString().replaceAll(":", "-"),
    serial.replace(/[^a-zA-Z0-9_.-]/g, "_"),
  );
  fs.mkdirSync(outputDir, { recursive: true });
  const run = (command, argv, timeout = 120000) =>
    execFileSync(command, argv, {
      cwd: root,
      encoding: "utf8",
      timeout,
      maxBuffer: 32 * 1024 * 1024,
    });
  const adb = (...argv) => run("adb", ["-s", serial, ...argv]);
  // This lane installs isolated test packages and may seed device fixtures. Never
  // run it against a user's physical phone or read their inbox/usage history.
  const hardware = adb("shell", "getprop", "ro.hardware").trim();
  if (!/^(ranchu|goldfish|cutf_cvm)$/.test(hardware))
    throw new Error(`Expected an emulator, got ro.hardware=${hardware}`);
  const networkTransitions = args.includes("--network-transitions");
  if (networkTransitions) {
    if (
      !/^(ranchu|goldfish)$/.test(hardware) ||
      selected.length !== 1 ||
      selected[0].directory !== "plugin-native-network-policy"
    )
      throw new Error(
        "Network transitions require a stock isolated emulator and --plugin plugin-native-network-policy",
      );
    if (adb("shell", "pm", "list", "packages", "ai.elizaos.app").trim())
      throw new Error(
        "Network transitions require an emulator without the user app installed",
      );
  }
  const dnsOutage = args.includes("--dns-outage");
  const dnsOutageChain = dnsOutage
    ? `ELIZA_DNS_${randomBytes(6).toString("hex")}`
    : undefined;
  if (dnsOutage) {
    if (
      !/^(ranchu|goldfish)$/.test(hardware) ||
      selected.length !== 1 ||
      selected[0].directory !== "plugin-native-websiteblocker" ||
      adb("shell", "pm", "list", "packages", "ai.elizaos.app").trim()
    )
      throw new Error(
        "DNS outage requires an isolated stock emulator without the user app and --plugin plugin-native-websiteblocker",
      );
  }
  const systemControls = args.includes("--system-controls");
  if (
    systemControls &&
    (!/^(ranchu|goldfish)$/.test(hardware) ||
      selected.length !== 1 ||
      selected[0].directory !== "plugin-native-system" ||
      adb("shell", "pm", "list", "packages", "ai.elizaos.app").trim())
  )
    throw new Error(
      "System controls require an isolated stock emulator without the user app and --plugin plugin-native-system",
    );
  const lease = await acquireDeviceLease(`android:${serial}`, { waitMs: 0 });
  const report = {
    serial,
    hardware,
    networkTransitions,
    dnsOutage,
    dnsOutageChain,
    systemControls,
    revision: run("git", ["rev-parse", "HEAD"]).trim(),
    worktreeChanges: run("git", ["status", "--porcelain"]),
    startedAt: new Date().toISOString(),
    builtFromCheckout: !args.includes("--no-build"),
    inventory: plugins,
    results: [],
  };
  try {
    // Persist ownership before device mutations, including interrupted-run recovery.
    fs.writeFileSync(
      path.join(outputDir, "report.json"),
      JSON.stringify(report, null, 2),
    );
    report.device = {
      sdk: adb("shell", "getprop", "ro.build.version.sdk").trim(),
      fingerprint: adb("shell", "getprop", "ro.build.fingerprint").trim(),
      webView: adb("shell", "dumpsys", "webviewupdate").trim(),
    };
    if (!args.includes("--no-build")) {
      console.log(`Building ${selected.length} Android native test APKs`);
      let build;
      try {
        build = run(
          path.join(root, "packages/app/platforms/android/gradlew"),
          [
            "-p",
            "packages/app/scripts/android-native-plugins-gradle",
            "--no-daemon",
            "--max-workers=4",
            ...selected.map(
              (plugin) => `:${plugin.project}:assembleDebugAndroidTest`,
            ),
            ...(selected.some(
              (plugin) => plugin.directory === "plugin-native-appblocker",
            )
              ? [":native-block-target:assembleDebug"]
              : []),
          ],
          1200000,
        );
      } catch (error) {
        fs.writeFileSync(
          path.join(outputDir, "build.log"),
          `${error.stdout ?? ""}\n${error.stderr ?? ""}`,
        );
        report.buildError = String(error);
        throw error;
      }
      fs.writeFileSync(path.join(outputDir, "build.log"), build);
    }
    for (const plugin of selected) {
      const entry = {
        plugin: plugin.directory,
        pass: false,
        tests: [],
        problems: [],
      };
      report.results.push(entry);
      let applicationId;
      let fixtureInstalled = false;
      let preservePackageForRecovery = false;
      const saveArtifact = ({ name, bytes }, prefix = "") => {
        const relativePath = `${plugin.directory}/${prefix}${name}`;
        const destination = path.join(outputDir, relativePath);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.writeFileSync(destination, bytes);
        return {
          path: relativePath,
          bytes: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        };
      };

      try {
        adb("logcat", "-c");
        if (plugin.directory === "plugin-native-appblocker") {
          const fixture = path.join(
            root,
            "packages/app/scripts/android-native-plugins-gradle/native-block-target/build/outputs/apk/debug/native-block-target-debug.apk",
          );
          entry.fixtureApkSha256 = createHash("sha256")
            .update(fs.readFileSync(fixture))
            .digest("hex");
          fixtureInstalled = true;
          adb("install", "-r", "-t", fixture);
        }
        if (!plugin.tests.length)
          throw new Error("No Android device tests exist");
        const apkDir = path.join(
          root,
          "plugins",
          plugin.directory,
          "android/build/outputs/apk/androidTest/debug",
        );
        const metadata = JSON.parse(
          fs.readFileSync(path.join(apkDir, "output-metadata.json"), "utf8"),
        );
        applicationId = metadata.applicationId;
        if (!applicationId.endsWith(".test") || metadata.elements.length !== 1)
          throw new Error("Expected a single isolated instrumentation APK");
        const apk = path.join(apkDir, metadata.elements[0].outputFile);
        entry.apkSha256 = createHash("sha256")
          .update(fs.readFileSync(apk))
          .digest("hex");
        if (plugin.directory === "plugin-native-camera") {
          // The real microphone-denial test owns its prompt; pregrant only camera access.
          adb("install", "-r", "-t", apk);
          adb(
            "shell",
            "pm",
            "grant",
            applicationId,
            "android.permission.CAMERA",
          );
        } else if (plugin.directory === "plugin-native-system") {
          // Flashlight contracts exercise the actual camera permission dialog.
          adb("install", "-r", "-t", apk);
        } else {
          adb("install", "-r", "-t", "-g", apk);
        }
        if (plugin.directory === "plugin-native-mobile-signals")
          adb(
            "shell",
            "appops",
            "set",
            "--uid",
            applicationId,
            "android:get_usage_stats",
            "allow",
          );
        // CameraX follows the host activity lifecycle; a sleeping emulator stops
        // the activity even though its WebView can still answer JavaScript.
        adb("shell", "input", "keyevent", "KEYCODE_WAKEUP");
        adb("shell", "wm", "dismiss-keyguard");
        if (plugin.directory === "plugin-native-contacts") {
          // Revocation kills the package; do it before instrumentation starts.
          for (const permission of ["READ_CONTACTS", "WRITE_CONTACTS"])
            adb(
              "shell",
              "pm",
              "revoke",
              applicationId,
              `android.permission.${permission}`,
            );
          const preflight = adb(
            "shell",
            "am",
            "instrument",
            "-w",
            "-r",
            "-e",
            "class",
            "ai.eliza.plugins.contacts.ContactsPermissionInstrumentedTest",
            "-e",
            "contactsPermissionPreflight",
            "1",
            `${applicationId}/androidx.test.runner.AndroidJUnitRunner`,
          );
          fs.writeFileSync(
            path.join(outputDir, `${plugin.directory}-permissions.log`),
            preflight,
          );
          entry.permissionPreflight = parseInstrumentation(preflight, 1);
          entry.artifacts = parseNativeArtifacts(preflight).map((artifact) =>
            saveArtifact(artifact),
          );
          if (
            !entry.permissionPreflight.pass ||
            !entry.artifacts.some((artifact) =>
              artifact.path.endsWith("/contacts-permissions-preflight.json"),
            )
          )
            throw new Error(
              `Contacts permission preflight failed: ${entry.permissionPreflight.problems.join("; ")}`,
            );
        }
        const output = run(
          "adb",
          [
            "-s",
            serial,
            "shell",
            "am",
            "instrument",
            "-w",
            "-r",
            ...(networkTransitions ? ["-e", "networkTransitions", "1"] : []),
            ...(systemControls ? ["-e", "systemControls", "1"] : []),
            ...(dnsOutage
              ? ["-e", "dnsOutage", "1", "-e", "dnsOutageChain", dnsOutageChain]
              : []),
            `${applicationId}/androidx.test.runner.AndroidJUnitRunner`,
          ],
          300000,
        ); // Includes real one-minute expiry/replacement contracts.

        fs.writeFileSync(
          path.join(outputDir, `${plugin.directory}.log`),
          output,
        );
        Object.assign(
          entry,
          parseInstrumentation(output, plugin.expectedTests),
        );
        entry.artifacts = [
          ...(entry.artifacts ?? []),
          ...parseNativeArtifacts(output).map((artifact) =>
            saveArtifact(artifact),
          ),
        ];
        if (systemControls) {
          for (const stage of [
            "denied",
            "granted",
            "clamped",
            "revoked",
            "restored",
          ]) {
            for (const source of ["bridge", "native"]) {
              const name = `system-controls-${stage}-${source}.json`;
              if (
                !entry.artifacts.some((artifact) =>
                  artifact.path.endsWith(`/${name}`),
                )
              ) {
                entry.pass = false;
                entry.problems.push(`Missing system control proof: ${name}`);
              }
            }
          }
        }
        if (systemControls && entry.pass) {
          const recovery = adb(
            "shell",
            "am",
            "instrument",
            "-w",
            "-r",
            "-e",
            "class",
            "ai.eliza.testing.NativeBridgeInstrumentedTest",
            "-e",
            "systemControlsPrepareRecovery",
            "1",
            `${applicationId}/androidx.test.runner.AndroidJUnitRunner`,
          );
          fs.writeFileSync(
            path.join(outputDir, "system-controls-recovery-prepare.log"),
            recovery,
          );
          entry.artifacts.push(
            ...parseNativeArtifacts(recovery).map((artifact) =>
              saveArtifact(artifact, "recovery-"),
            ),
          );
          if (!parseInstrumentation(recovery, 1).pass)
            throw new Error("System controls recovery preparation failed");
        }
        if (dnsOutage) {
          for (const name of [
            "vpn-upstream-outage.json",
            "vpn-upstream-outage-cleanup.json",
          ]) {
            if (
              !entry.artifacts.some((artifact) =>
                artifact.path.endsWith(`/${name}`),
              )
            ) {
              entry.pass = false;
              entry.problems.push(`Missing DNS outage proof: ${name}`);
            }
          }
        }
      } catch (error) {
        entry.pass = false;
        entry.problems.push(String(error));
        if (error.stdout)
          fs.writeFileSync(
            path.join(outputDir, `${plugin.directory}.log`),
            error.stdout,
          );
      } finally {
        if (systemControls && applicationId?.endsWith(".test")) {
          try {
            const cleanup = adb(
              "shell",
              "am",
              "instrument",
              "-w",
              "-r",
              "-e",
              "class",
              "ai.eliza.testing.NativeBridgeInstrumentedTest",
              "-e",
              "systemControlsRestore",
              "1",
              `${applicationId}/androidx.test.runner.AndroidJUnitRunner`,
            );
            fs.writeFileSync(
              path.join(outputDir, "system-controls-host-cleanup.log"),
              cleanup,
            );
            const artifacts = parseNativeArtifacts(cleanup);
            entry.artifacts ??= [];
            entry.artifacts.push(
              ...artifacts.map((artifact) =>
                saveArtifact(artifact, "recovery-"),
              ),
            );
            if (
              entry.pass &&
              !artifacts.some(
                ({ name }) => name === "system-controls-restoration.json",
              )
            ) {
              entry.pass = false;
              entry.problems.push(
                "Missing fresh-process system controls restoration evidence",
              );
            }
            if (!parseInstrumentation(cleanup, 1).pass) {
              preservePackageForRecovery = true;
              entry.pass = false;
              entry.problems.push(
                "System settings restoration failed; preserve the test APK recovery record",
              );
            }
          } catch (error) {
            preservePackageForRecovery = true;
            entry.pass = false;
            entry.problems.push(`System settings cleanup: ${error}`);
          }
        }
        if (dnsOutage) {
          try {
            const iptables = (...args) =>
              adb("shell", "su", "0", "iptables", "-w", ...args);
            // The host owns this unique chain too, so crashes cannot strand the outage.
            if (
              iptables("-S")
                .split("\n")
                .some((line) => line.trim() === `-N ${dnsOutageChain}`)
            ) {
              const rule = [
                "-p",
                "udp",
                "--sport",
                "53",
                "!",
                "-s",
                "10.77.0.2",
                "-j",
                dnsOutageChain,
              ];
              if (
                iptables("-S", "INPUT")
                  .split("\n")
                  .some((line) => line.trim().endsWith(`-j ${dnsOutageChain}`))
              )
                iptables("-D", "INPUT", ...rule);
              iptables("-F", dnsOutageChain);
              iptables("-X", dnsOutageChain);
            }
            fs.writeFileSync(
              path.join(outputDir, "dns-outage-host-cleanup.json"),
              JSON.stringify({ chain: dnsOutageChain, absent: true }),
            );
          } catch (error) {
            entry.pass = false;
            entry.problems.push(`DNS outage cleanup: ${error}`);
          }
        }
        try {
          fs.writeFileSync(
            path.join(outputDir, `${plugin.directory}-logcat.log`),
            adb("logcat", "-d"),
          );
        } catch (error) {
          entry.pass = false;
          entry.problems.push(`Android log capture: ${error}`);
        }
        if (fixtureInstalled) {
          try {
            adb("uninstall", "ai.eliza.testing.blocktarget");
          } catch (error) {
            entry.pass = false;
            entry.problems.push(`fixture cleanup: ${error}`);
          }
        }
        if (plugin.directory === "plugin-native-mobile-signals") {
          try {
            restoreMobileSignalsScreen(adb, outputDir);
          } catch (error) {
            entry.pass = false;
            entry.problems.push(`screen-state cleanup: ${error}`);
          }
        }
        if (applicationId?.endsWith(".test") && !preservePackageForRecovery) {
          try {
            adb("uninstall", applicationId);
          } catch (error) {
            entry.pass = false;
            entry.problems.push(`cleanup: ${error}`);
          }
        }
      }
      console.log(
        `${entry.pass ? "PASS" : "FAIL"} ${plugin.directory}: ${entry.tests.filter((test) => test.status === "passed").length}/${plugin.expectedTests} passed`,
      );
      fs.writeFileSync(
        path.join(outputDir, "report.json"),
        JSON.stringify(report, null, 2),
      );
    }
  } finally {
    report.finishedAt = new Date().toISOString();
    report.pass =
      report.results.length === selected.length &&
      report.results.every((entry) => entry.pass);
    fs.writeFileSync(
      path.join(outputDir, "report.json"),
      JSON.stringify(report, null, 2),
    );
    lease.release();
  }
  console.log(`Evidence: ${path.join(outputDir, "report.json")}`);
  if (!report.pass) process.exitCode = 1;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
