// OTA update client, interrupted-update handling and rollback/recovery tooling. The
// device is a simulated adb/fastboot state machine and every record is synthetic: these
// tests establish refusals, journaling and resume decisions. They are not an applied
// OTA, an interrupted-update, rollback or stock-recovery drill on hardware.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyUpdate,
  classifyUpdate,
  fallbackProblems,
  fallbackToOriginalSlot,
  main,
  parseArgs,
  parseGetprop,
  readJournal,
  releaseRecordProblems,
  stockRecoveryPlan,
  updateStatus,
  updateTransitionProblems,
  verifyStockRecovery,
} from "../android/aosp-ota-update.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const OTA_CERT = "b".repeat(64);
const AVB_KEY = "a".repeat(64);
const FP = (build) =>
  `elizaOS/eliza_stallion_phone/stallion:17/CP2A.${build}/1:user/release-keys`;

const CHANNEL = Object.freeze({
  schema: 1,
  channel: "stable",
  product: "eliza_stallion_phone",
  device: "stallion",
  otaCertificateSha256: OTA_CERT,
  avbPublicKeySha256: AVB_KEY,
  downgradeAllowed: false,
  recovery: {
    stockFactoryImage: {
      filename: "stallion-test-factory.zip",
      sha256: "0".repeat(64),
    },
  },
});

function temporary(t, prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A synthetic compatibility record (the shape aosp-release-record.mjs writes). */
function record({
  build,
  dateUtc,
  securityPatch = "2026-10-05",
  vendorSecurityPatch = "2026-10-05",
  indexes = ["1", "1", "1"],
  otaBytes = Buffer.from(`ota ${build}`),
  type = "full",
  from = null,
  releasekey = OTA_CERT,
  avb = AVB_KEY,
  problems = [],
}) {
  return {
    schema: 1,
    kind: "aosp-release-compatibility",
    product: "eliza_stallion_phone",
    device: "stallion",
    channel: "stable",
    build: {
      fingerprint: FP(build),
      androidRelease: "17",
      securityPatch,
      vendorSecurityPatch,
      dateUtc,
    },
    artifacts: {
      signedTargetFiles: {
        file: "signed-target_files.zip",
        sha256: sha256(Buffer.from(`tf ${build}`)),
      },
      ota: {
        file: type === "full" ? "ota.zip" : "incremental-ota.zip",
        sha256: sha256(otaBytes),
        sizeBytes: otaBytes.length,
        type,
        incrementalFrom: from
          ? {
              file: "signed-target_files.zip",
              sha256: from.artifacts.signedTargetFiles.sha256,
            }
          : null,
      },
    },
    verifiedBoot: {
      publicKeySha256: avb,
      rollbackIndexes: indexes.map((index, location) => ({
        partition: ["vbmeta", "vbmeta_system", "vbmeta_vendor"][location],
        location,
        index,
      })),
    },
    payload: {
      metadata: {
        "post-build": FP(build),
        "post-timestamp": dateUtc,
        ...(from ? { "pre-build": from.build.fingerprint } : {}),
      },
    },
    certificates: { releasekey, platform: "c".repeat(64) },
    problems,
    imageBooted: false,
    signedUpdateApplied: false,
    releaseQualified: false,
    deviceAcceptanceVerified: false,
  };
}
const INSTALLED = record({ build: "261005.001", dateUtc: "1790000000" });
const CANDIDATE = record({
  build: "261105.001",
  dateUtc: "1792000000",
  securityPatch: "2026-11-05",
  vendorSecurityPatch: "2026-11-05",
});

test("compatible updates are newer, verifiable by the installed image and never lower a rollback index", () => {
  assert.deepEqual(
    updateTransitionProblems({
      from: INSTALLED,
      to: CANDIDATE,
      channel: CHANNEL,
    }),
    [],
  );
  const refused = (to, pattern, from = INSTALLED, channel = CHANNEL) => {
    const problems = updateTransitionProblems({ from, to, channel });
    assert.ok(
      problems.some((problem) => pattern.test(problem)),
      `${pattern}\n${problems.join("\n")}`,
    );
  };
  refused(
    record({ build: "260905.001", dateUtc: "1780000000" }),
    /not newer than the installed 1790000000; downgrades are refused/,
  );
  refused(INSTALLED, /the candidate is the installed build/);
  refused(
    record({
      build: "261105.001",
      dateUtc: "1792000000",
      securityPatch: "2026-09-05",
    }),
    /security patch 2026-09-05 is older/,
  );
  refused(
    record({
      build: "261105.001",
      dateUtc: "1792000000",
      vendorSecurityPatch: "2026-09-05",
    }),
    /vendor security patch 2026-09-05 is older/,
  );
  refused(
    record({
      build: "261105.001",
      dateUtc: "1792000000",
      indexes: ["1", "0", "1"],
    }),
    /location 1 would fall from 1 to 0/,
  );
  refused(
    record({ build: "261105.001", dateUtc: "1792000000", indexes: ["1", "1"] }),
    /no AVB rollback index at location 2/,
  );
  refused(
    record({
      build: "261105.001",
      dateUtc: "1792000000",
      releasekey: "e".repeat(64),
    }),
    /candidate OTA package certificate is not the channel's/,
  );
  refused(
    record({ build: "261105.001", dateUtc: "1792000000", avb: "e".repeat(64) }),
    /candidate AVB key is not the channel's/,
  );
  refused(
    record({
      build: "261105.001",
      dateUtc: "1792000000",
      problems: ["payload mismatch"],
    }),
    /lists problems/,
  );
  refused(
    { ...CANDIDATE, signedUpdateApplied: true },
    /claims signedUpdateApplied/,
  );
  refused({ ...CANDIDATE, channel: "beta" }, /is not a stable release/);
  refused(
    { ...CANDIDATE, payload: { metadata: { "post-timestamp": "1" } } },
    /post-timestamp is not the candidate build date/,
  );
  refused(CANDIDATE, /must refuse downgrades/, INSTALLED, {
    ...CHANNEL,
    downgradeAllowed: true,
  });
  // Incremental packages start from exactly the installed build and its signed target-files.
  const incremental = record({
    build: "261105.001",
    dateUtc: "1792000000",
    type: "incremental",
    from: INSTALLED,
  });
  assert.deepEqual(
    updateTransitionProblems({
      from: INSTALLED,
      to: incremental,
      channel: CHANNEL,
    }),
    [],
  );
  const other = record({ build: "260901.001", dateUtc: "1789000000" });
  refused(
    record({
      build: "261105.001",
      dateUtc: "1792000000",
      type: "incremental",
      from: other,
    }),
    /starts from .*260901.*not the installed/,
  );
  refused(
    {
      ...incremental,
      artifacts: {
        ...incremental.artifacts,
        ota: {
          ...incremental.artifacts.ota,
          incrementalFrom: { sha256: "9".repeat(64) },
        },
      },
    },
    /not built from the installed release's signed target-files/,
  );
  // The device's own identity must be the installed release.
  const observed = updateTransitionProblems({
    from: INSTALLED,
    to: CANDIDATE,
    channel: CHANNEL,
    observed: { device: "stallion", fingerprint: FP("other") },
  });
  assert.ok(
    observed.some((problem) =>
      /the device runs .*other.*not the installed release/.test(problem),
    ),
  );
  assert.match(
    releaseRecordProblems(null, CHANNEL).join("\n"),
    /missing or unreadable/,
  );
});

/**
 * A simulated A/B device. Recovery sideload writes the candidate to the other slot;
 * `behavior` scripts failures: "fail" (recovery refuses), "unplug" (the transfer is
 * interrupted and the device disappears), "fallback" (the updated slot does not boot
 * and the bootloader returns to the original slot), "permissive" (the updated image
 * boots with SELinux permissive).
 */
function simulatedDevice({
  fingerprint = INSTALLED.build.fingerprint,
  slot = "a",
  behavior = [],
  successful = "no",
  snapshot = "snapshotted",
} = {}) {
  const sim = {
    state: "device",
    slot,
    fingerprint,
    securityPatch: "2026-10-05",
    selinux: "Enforcing",
    locked: "1",
    verifiedBoot: "green",
    slots: {
      a: { fingerprint: slot === "a" ? fingerprint : null },
      b: { fingerprint: slot === "b" ? fingerprint : null },
    },
    successful,
    snapshot,
    behavior: [...behavior],
  };
  const calls = [];
  const other = (value) => (value === "a" ? "b" : "a");
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const fail = (stderr) => ({ status: 1, stdout: "", stderr });
  const boot = () => {
    sim.state = "device";
    sim.fingerprint = sim.slots[sim.slot].fingerprint;
    sim.securityPatch =
      sim.fingerprint === CANDIDATE.build.fingerprint
        ? CANDIDATE.build.securityPatch
        : "2026-10-05";
  };
  const device = {
    serial: "SIMULATED01",
    sim,
    calls,
    adb(args, { allowFailure = false } = {}) {
      calls.push(["adb", ...args]);
      let result: { status: number; stdout: string; stderr: string };
      const [command, ...rest] = args;
      if (command === "get-state")
        result = ["device", "recovery", "sideload"].includes(sim.state)
          ? ok(`${sim.state}\n`)
          : fail("error: device not found");
      else if (sim.state === "absent" || sim.state === "bootloader")
        result = fail("error: device not found");
      else if (
        command === "shell" &&
        rest[0] === "getprop" &&
        sim.state === "device"
      )
        result = ok(
          [
            ["ro.product.device", "stallion"],
            ["ro.build.fingerprint", sim.fingerprint],
            [
              "ro.build.date.utc",
              sim.fingerprint === CANDIDATE.build.fingerprint
                ? CANDIDATE.build.dateUtc
                : INSTALLED.build.dateUtc,
            ],
            ["ro.build.version.security_patch", sim.securityPatch],
            ["ro.boot.slot_suffix", `_${sim.slot}`],
            ["sys.boot_completed", "1"],
            ["ro.boot.verifiedbootstate", sim.verifiedBoot],
            ["ro.boot.flash.locked", sim.locked],
          ]
            .map(([key, value]) => `[${key}]: [${value}]`)
            .join("\n"),
        );
      else if (
        command === "shell" &&
        rest[0] === "getenforce" &&
        sim.state === "device"
      )
        result = ok(`${sim.selinux}\n`);
      else if (command === "reboot" && rest[0] === "sideload") {
        sim.state = "sideload";
        result = ok();
      } else if (command === "reboot" && rest[0] === "bootloader") {
        sim.state = "bootloader";
        result = ok();
      } else if (command === "sideload" && sim.state === "sideload") {
        const next = sim.behavior.shift();
        if (next === "fail")
          result = fail("adb: failed to read command: Success");
        else if (next === "unplug") {
          sim.state = "absent";
          result = fail("adb: failed to read command: device offline");
        } else {
          sim.slots[other(sim.slot)].fingerprint = CANDIDATE.build.fingerprint;
          sim.pending = other(sim.slot);
          sim.updateBehavior = next;
          result = ok("Total xfer: 1.00x\n");
        }
      } else if (command === "reboot" && rest.length === 0) {
        if (sim.pending && sim.updateBehavior !== "fallback")
          sim.slot = sim.pending;
        if (sim.updateBehavior === "permissive") sim.selinux = "Permissive";
        sim.pending = null;
        boot();
        result = ok();
      } else result = fail(`unexpected adb ${args.join(" ")} in ${sim.state}`);
      if (!allowFailure && result.status !== 0) throw new Error(result.stderr);
      return result;
    },
    fastboot(args, { allowFailure = false } = {}) {
      calls.push(["fastboot", ...args]);
      let result: { status: number; stdout: string; stderr: string };
      if (sim.state !== "bootloader") result = fail("< waiting for device >");
      else if (args[0] === "getvar") {
        const name = args[1];
        const values = {
          product: "stallion",
          "current-slot": sim.slot,
          unlocked: sim.locked === "1" ? "no" : "yes",
          "snapshot-update-status": sim.snapshot,
          [`slot-successful:${sim.slot}`]: sim.successful,
          [`slot-successful:${other(sim.slot)}`]: "yes",
          "slot-unbootable:a": "no",
          "slot-unbootable:b": "no",
          "slot-retry-count:a": "7",
          "slot-retry-count:b": "7",
        };
        result =
          values[name] === undefined
            ? fail(
                `getvar:${name} FAILED (remote: 'GetVar Variable Not found')`,
              )
            : {
                status: 0,
                stdout: "",
                stderr: `${name}: ${values[name]}\nFinished. Total time: 0.001s\n`,
              };
      } else if (args[0] === "set_active") {
        sim.slot = args[1];
        result = ok();
      } else if (args[0] === "reboot") {
        boot();
        result = ok();
      } else result = fail(`unexpected fastboot ${args.join(" ")}`);
      if (!allowFailure && result.status !== 0) throw new Error(result.stderr);
      return result;
    },
    fastbootDevices() {
      calls.push(["fastboot", "devices"]);
      return sim.state === "bootloader" ? `${device.serial}\tfastboot\n` : "";
    },
  };
  return device;
}

/** Records and the candidate OTA package on disk, a private lock directory and a journal path. */
function operation(t, candidate = CANDIDATE) {
  const dir = temporary(t, "ota-update-");
  const write = (name, value) => {
    const file = path.join(dir, name);
    fs.writeFileSync(
      file,
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    );
    return file;
  };
  const lockDirectory = path.join(dir, "locks");
  fs.mkdirSync(lockDirectory, { mode: 0o700 });
  return {
    dir,
    lockDirectory,
    options: {
      channel: CHANNEL,
      from: write("installed-record.json", INSTALLED),
      to: write("candidate-record.json", candidate),
      ota: write(
        candidate.artifacts.ota.file,
        Buffer.from(
          `ota ${candidate.build.fingerprint.split("/")[3].slice(5)}`,
        ),
      ),
      journalFile: path.join(dir, "update-journal.json"),
      lockDirectory,
      timing: { wait: () => {}, rebootMs: 0, sideloadMs: 1000 },
    },
  };
}
const writesOf = (device) =>
  device.calls.filter(
    (call) =>
      !(
        call[1] === "get-state" ||
        call[1] === "shell" ||
        call[1] === "getvar" ||
        call[1] === "devices"
      ),
  );
const states = (file) => readJournal(file).events.map((entry) => entry.state);

test("the candidate package and records are checked before any device write; a dry run only observes", (t) => {
  const run = operation(t);
  const device = simulatedDevice();
  const dry = applyUpdate({ device, ...run.options });
  assert.deepEqual(dry.problems, []);
  assert.equal(dry.executed, false);
  assert.equal(dry.plan.next, "sideload");
  assert.deepEqual(writesOf(device), []);
  assert.equal(fs.existsSync(run.options.journalFile), false);
  assert.throws(
    () => applyUpdate({ device, ...run.options, execute: true }),
    /add --confirm-update/,
  );
  assert.deepEqual(writesOf(device), []);
  // A package other than the recorded one, a device on another build and a downgrade are refused.
  fs.writeFileSync(run.options.ota, "tampered");
  assert.match(
    applyUpdate({
      device,
      ...run.options,
      execute: true,
      confirm: true,
    }).problems.join("\n"),
    /not the one the candidate record describes/,
  );
  const otherBuild = simulatedDevice({ fingerprint: FP("unknown") });
  const refused = applyUpdate({
    device: otherBuild,
    ...operation(t).options,
    execute: true,
    confirm: true,
  });
  assert.match(
    refused.problems.join("\n"),
    /the device runs .*unknown.*not the installed release/,
  );
  assert.deepEqual(writesOf(otherBuild), []);
  const downgrade = operation(
    t,
    record({ build: "260905.001", dateUtc: "1780000000" }),
  );
  assert.match(
    applyUpdate({
      device: simulatedDevice(),
      ...downgrade.options,
    }).problems.join("\n"),
    /downgrades are refused/,
  );
});

test("a confirmed update is journaled through recovery sideload and verified on the other slot", (t) => {
  const run = operation(t);
  const device = simulatedDevice();
  const result = applyUpdate({
    device,
    ...run.options,
    execute: true,
    confirm: true,
  });
  assert.equal(result.executed, true);
  assert.deepEqual(states(run.options.journalFile), [
    "preflight",
    "sideload",
    "transferred",
    "rebooted",
    "verified",
  ]);
  const journal = readJournal(run.options.journalFile);
  assert.equal(journal.signedUpdateApplied, true);
  assert.equal(journal.drillRecorded, false);
  assert.equal(journal.from.slot, "a");
  assert.equal(device.sim.slot, "b");
  assert.equal(device.sim.fingerprint, CANDIDATE.build.fingerprint);
  assert.deepEqual(
    writesOf(device).map((call) => call.slice(0, 3).join(" ")),
    ["adb reboot sideload", `adb sideload ${run.options.ota}`, "adb reboot"],
  );
  assert.equal(fs.statSync(run.options.journalFile).mode & 0o077, 0);
  assert.deepEqual(
    fs.readdirSync(run.lockDirectory),
    [],
    "a completed update releases the device lock",
  );
  // Running again is a no-op on a verified journal.
  const again = applyUpdate({
    device,
    ...run.options,
    execute: true,
    confirm: true,
  });
  assert.equal(again.executed, false);
  assert.equal(writesOf(device).length, 3);
});

test("a refused or unplugged transfer is journaled, keeps the lock and resumes from the observed device", (t) => {
  // Recovery refuses the package: the installed slot is untouched and the lock stays for the operator.
  let run = operation(t);
  let device = simulatedDevice({ behavior: ["fail"] });
  assert.throws(
    () => applyUpdate({ device, ...run.options, execute: true, confirm: true }),
    /recovery did not accept the OTA package/,
  );
  assert.equal(readJournal(run.options.journalFile).state, "transfer-failed");
  assert.equal(
    fs.readdirSync(run.lockDirectory).length,
    1,
    "failed writes keep the device lock",
  );
  assert.throws(
    () => applyUpdate({ device, ...run.options, execute: true, confirm: true }),
    /device installation locked/,
  );
  for (const name of fs.readdirSync(run.lockDirectory))
    fs.rmSync(path.join(run.lockDirectory, name));
  const status = updateStatus({ device, journalFile: run.options.journalFile });
  assert.equal(status.next, "sideload");
  const resumed = applyUpdate({
    device,
    ...run.options,
    execute: true,
    confirm: true,
  });
  assert.equal(resumed.executed, true);
  assert.deepEqual(states(run.options.journalFile), [
    "preflight",
    "sideload",
    "transfer-failed",
    "sideload",
    "transferred",
    "rebooted",
    "verified",
  ]);
  // The cable is pulled mid-transfer, and the phone later reboots into its installed build.
  run = operation(t);
  device = simulatedDevice({ behavior: ["unplug"] });
  assert.throws(
    () => applyUpdate({ device, ...run.options, execute: true, confirm: true }),
    /recovery did not accept/,
  );
  assert.equal(
    updateStatus({ device, journalFile: run.options.journalFile }).next,
    "absent",
  );
  device.sim.state = "device";
  const observed = updateStatus({
    device,
    journalFile: run.options.journalFile,
  });
  assert.equal(observed.next, "retry");
  assert.match(
    observed.reason,
    /did not take effect, or the bootloader fell back/,
  );
  for (const name of fs.readdirSync(run.lockDirectory))
    fs.rmSync(path.join(run.lockDirectory, name));
  assert.deepEqual(applyUpdate({ device, ...run.options }).plan.next, "retry");
  applyUpdate({ device, ...run.options, execute: true, confirm: true });
  assert.deepEqual(states(run.options.journalFile).slice(-5), [
    "interrupted",
    "sideload",
    "transferred",
    "rebooted",
    "verified",
  ]);
});

test("an updated slot that does not boot falls back without a false success, and the candidate is never re-verified blindly", (t) => {
  const run = operation(t);
  const device = simulatedDevice({ behavior: ["fallback"] });
  assert.throws(
    () => applyUpdate({ device, ...run.options, execute: true, confirm: true }),
    /rebooted into the installed build; the update did not take effect/,
  );
  const journal = readJournal(run.options.journalFile);
  assert.equal(journal.state, "interrupted");
  assert.equal(journal.signedUpdateApplied, false);
  // An updated image that boots permissive fails verification and is not recorded applied.
  const permissive = operation(t);
  const weak = simulatedDevice({ behavior: ["permissive"] });
  assert.throws(
    () =>
      applyUpdate({
        device: weak,
        ...permissive.options,
        execute: true,
        confirm: true,
      }),
    /failed verification[\s\S]*SELinux is not enforcing/,
  );
  assert.equal(
    readJournal(permissive.options.journalFile).state,
    "verification-failed",
  );
  assert.equal(
    readJournal(permissive.options.journalFile).signedUpdateApplied,
    false,
  );
  // A journal for another package is never resumed.
  const otherPackage = operation(
    t,
    record({
      build: "261205.001",
      dateUtc: "1793000000",
      securityPatch: "2026-12-05",
      vendorSecurityPatch: "2026-12-05",
    }),
  );
  fs.copyFileSync(run.options.journalFile, otherPackage.options.journalFile);
  fs.chmodSync(otherPackage.options.journalFile, 0o600);
  assert.match(
    applyUpdate({
      device: simulatedDevice(),
      ...otherPackage.options,
    }).problems.join("\n"),
    /journal belongs to another device, package or release/,
  );
});

test("a journaled transfer whose candidate already booted is verified without repeating the update", (t) => {
  const run = operation(t);
  const device = simulatedDevice();
  applyUpdate({ device, ...run.options, execute: true, confirm: true });
  const journal = readJournal(run.options.journalFile);
  journal.state = "transferred";
  journal.signedUpdateApplied = false;
  fs.writeFileSync(run.options.journalFile, JSON.stringify(journal));
  const before = writesOf(device).length;
  const result = applyUpdate({
    device,
    ...run.options,
    execute: true,
    confirm: true,
  });
  assert.equal(result.executed, true);
  assert.equal(
    writesOf(device).length,
    before,
    "verification reads the device only",
  );
  assert.equal(readJournal(run.options.journalFile).state, "verified");
  assert.equal(
    classifyUpdate(journal, "device", {
      bootCompleted: true,
      device: "stallion",
      fingerprint: FP("other"),
      slot: "b",
    }).next,
    "refuse",
  );
});

test("fallback to the original slot is admitted only before the updated slot is marked successful", (t) => {
  const run = operation(t);
  const device = simulatedDevice();
  applyUpdate({ device, ...run.options, execute: true, confirm: true });
  // From booted Android the operator first enters the bootloader.
  assert.match(
    fallbackToOriginalSlot({
      device,
      journalFile: run.options.journalFile,
    }).problems.join("\n"),
    /enter the bootloader first/,
  );
  device.sim.state = "bootloader";
  device.sim.successful = "yes";
  assert.match(
    fallbackToOriginalSlot({
      device,
      journalFile: run.options.journalFile,
      execute: true,
      confirm: true,
    }).problems.join("\n"),
    /marked successful/,
  );
  device.sim.successful = "no";
  device.sim.snapshot = "merging";
  assert.match(
    fallbackToOriginalSlot({
      device,
      journalFile: run.options.journalFile,
    }).problems.join("\n"),
    /snapshot merge is in progress/,
  );
  device.sim.snapshot = "snapshotted";
  const dry = fallbackToOriginalSlot({
    device,
    journalFile: run.options.journalFile,
  });
  assert.deepEqual(dry.problems, []);
  assert.equal(dry.executed, false);
  assert.throws(
    () =>
      fallbackToOriginalSlot({
        device,
        journalFile: run.options.journalFile,
        lockDirectory: run.lockDirectory,
        execute: true,
      }),
    /add --confirm-fallback/,
  );
  const result = fallbackToOriginalSlot({
    device,
    journalFile: run.options.journalFile,
    lockDirectory: run.lockDirectory,
    execute: true,
    confirm: true,
    timing: { wait: () => {}, rebootMs: 0 },
  });
  assert.equal(result.executed, true);
  assert.equal(device.sim.slot, "a");
  assert.equal(device.sim.fingerprint, INSTALLED.build.fingerprint);
  const journal = readJournal(run.options.journalFile);
  assert.equal(journal.state, "rolled-back");
  assert.equal(journal.signedUpdateApplied, false);
  assert.match(
    applyUpdate({
      device,
      ...run.options,
      execute: true,
      confirm: true,
    }).problems.join("\n"),
    /records a fallback to the original slot; start a new journal/,
  );
  assert.ok(
    device.calls.some((call) => call.join(" ") === "fastboot set_active a"),
  );
  // Journals that never reached the updated slot have nothing to fall back from.
  assert.match(
    fallbackProblems(
      { ...journal, state: "preflight" },
      {
        currentSlot: "b",
        slots: { a: { unbootable: "no" }, b: { successful: "no" } },
      },
    ).join("\n"),
    /no updated slot/,
  );
});

test("stock recovery verifies the locked factory archive and returns a plan it never runs", (t) => {
  const dir = temporary(t, "stock-recovery-");
  const archive = path.join(dir, "stallion-test-factory.zip");
  execFileSync("python3", [
    "-c",
    "import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1],'w')\nfor n in sys.argv[2:]: z.writestr(n, n)\nz.close()",
    archive,
    "stallion-cp3a.261005.005/flash-all.sh",
    "stallion-cp3a.261005.005/bootloader-stallion-1.2.img",
    "stallion-cp3a.261005.005/radio-stallion-g5.img",
    "stallion-cp3a.261005.005/image-stallion-cp3a.261005.005.zip",
  ]);
  const bytes = fs.readFileSync(archive);
  const lock = {
    factory: {
      filename: "stallion-test-factory.zip",
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
      buildId: "CP3A.261005.005",
    },
  };
  const channel = {
    ...CHANNEL,
    recovery: {
      stockFactoryImage: {
        filename: lock.factory.filename,
        sha256: lock.factory.sha256,
      },
    },
  };
  const entries = execFileSync("unzip", ["-Z1", archive], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  const plan = stockRecoveryPlan({
    channel,
    sourceLock: lock,
    archive,
    entries,
  });
  assert.deepEqual(plan.problems, []);
  assert.equal(plan.executed, false);
  assert.deepEqual(
    plan.steps.map((step) => step.slice(3).join(" ")),
    [
      "reboot bootloader",
      "flashing unlock",
      "erase avb_custom_key",
      "flash bootloader stallion-cp3a.261005.005/bootloader-stallion-1.2.img",
      "reboot-bootloader",
      "flash radio stallion-cp3a.261005.005/radio-stallion-g5.img",
      "reboot-bootloader",
      "-w update stallion-cp3a.261005.005/image-stallion-cp3a.261005.005.zip",
    ],
  );
  const tampered = stockRecoveryPlan({
    channel: {
      ...channel,
      recovery: {
        stockFactoryImage: {
          ...channel.recovery.stockFactoryImage,
          sha256: "1".repeat(64),
        },
      },
    },
    sourceLock: lock,
    archive,
    entries,
  });
  assert.match(tampered.problems.join("\n"), /not the locked factory archive/);
  assert.deepEqual(tampered.steps, []);
  const partial = stockRecoveryPlan({
    channel,
    sourceLock: lock,
    archive,
    entries: entries.filter((name) => !/radio/.test(name)),
  });
  assert.match(partial.problems.join("\n"), /0 radio entries/);
  assert.match(
    stockRecoveryPlan({
      channel,
      sourceLock: { factory: { ...lock.factory, buildId: "CP4A.270101.001" } },
      archive,
      entries,
    }).problems.join("\n"),
    /not build CP4A/,
  );
  // A brand wrapper's channel and source lock are the command-line defaults.
  const channelFile = path.join(dir, "channel.json"),
    lockFile = path.join(dir, "lock.json");
  fs.writeFileSync(channelFile, JSON.stringify(channel));
  fs.writeFileSync(lockFile, JSON.stringify(lock));
  const printed = [];
  const log = console.log;
  console.log = (text) => printed.push(text);
  try {
    const result = main(["stock-archive", "--archive", archive], {
      channel: channelFile,
      sourceLock: lockFile,
    });
    assert.deepEqual(result.problems, []);
  } finally {
    console.log = log;
  }
  assert.equal(JSON.parse(printed[0]).steps.length, 8);
  // After the operator flashes it, the device must report that stock build.
  const device = simulatedDevice({
    fingerprint:
      "google/stallion/stallion:17/CP3A.261005.005/14300000:user/release-keys",
  });
  assert.equal(verifyStockRecovery({ device, sourceLock: lock }).passed, true);
  assert.match(
    verifyStockRecovery({
      device: simulatedDevice(),
      sourceLock: lock,
    }).problems.join("\n"),
    /not stock CP3A/,
  );
  assert.equal(writesOf(device).length, 0);
});

test("command-line options are explicit: confirmations belong to execution and read-only commands refuse it", () => {
  assert.deepEqual(
    parseArgs(["status", "--serial", "S1", "--journal", "j.json"]),
    { command: "status", serial: "S1", journal: "j.json" },
  );
  assert.throws(
    () => parseArgs(["apply", "--serial", "S1"]),
    /apply requires --channel/,
  );
  assert.throws(
    () =>
      parseArgs([
        "status",
        "--serial",
        "S1",
        "--journal",
        "j",
        "--confirm-update",
      ]),
    /belongs to apply --execute/,
  );
  assert.throws(
    () =>
      parseArgs([
        "check",
        "--channel",
        "c",
        "--from",
        "f",
        "--to",
        "t",
        "--execute",
      ]),
    /check is read-only/,
  );
  assert.throws(
    () =>
      parseArgs([
        "fallback",
        "--serial",
        "S",
        "--journal",
        "j",
        "--confirm-fallback",
      ]),
    /belongs to fallback --execute/,
  );
  assert.throws(() => parseArgs(["wipe"]), /Use check \| apply/);
  assert.throws(
    () =>
      parseArgs(["status", "--serial", "S", "--serial", "T", "--journal", "j"]),
    /duplicate --serial/,
  );
  assert.throws(() => parseArgs(["status", "--unknown"]), /unsupported option/);
  assert.deepEqual(parseGetprop("[a]: [1]\n[ro.x]: []\nnoise\n"), {
    a: "1",
    "ro.x": "",
  });
});
