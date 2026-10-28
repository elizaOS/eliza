#!/usr/bin/env node
/**
 * Operator OTA update client, interrupted-update handling and rollback/recovery
 * tooling for release-signed A/B AOSP images (Pixel 10a / stallion on Android 17).
 *
 * It applies exactly one release-signed OTA package to one serial-bound device
 * through that device's own recovery (`adb reboot recovery`, the operator's "Apply
 * update from ADB" choice, `adb sideload`), so the installed image verifies the
 * package against its otacerts and the bootloader enforces verified boot and
 * rollback protection. A user build's adbd cannot enter sideload by itself
 * (`adb reboot sideload` needs `adb root`), so the tool asks the operator for the
 * recovery menu choices and waits for the device. Nothing here signs, builds,
 * relocks or wipes. Each operation keeps a durable journal: an interruption is
 * resumed or reported from the device state it observes, never assumed complete.
 *
 *   check     --channel C --from INSTALLED_RECORD --to CANDIDATE_RECORD
 *   apply     --serial S --channel C --from INSTALLED_RECORD --to CANDIDATE_RECORD
 *             --ota OTA.zip --journal FILE [--execute --confirm-update]
 *   status    --serial S --journal FILE
 *   fallback  --serial S --journal FILE [--execute --confirm-fallback]
 *   stock-archive --channel C --source-lock LOCK --archive FACTORY.zip
 *   verify-stock  --serial S --source-lock LOCK
 *
 * The compatibility records come from aosp-release-record.mjs. A device running a
 * build no record describes is refused. Results are observations for the release
 * owner's drill record; this tool never marks a drill passed.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RECORD_KIND } from "./aosp-release-record.mjs";
import { syncDirectory, withDeviceInstallLock } from "./install-lock.ts";
import { HEX64 } from "./pixel10a-release.mjs";
import { hashFile } from "./release-contract.ts";

export const JOURNAL_KIND = "aosp-ota-update-journal";
const SERIAL = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SPL = /^\d{4}-\d{2}-\d{2}$/;
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const RECORD_FLAGS = [
  "imageBooted",
  "signedUpdateApplied",
  "releaseQualified",
  "deviceAcceptanceVerified",
];
/** Journal states after which the updated slot may be active. */
const FALLBACK_STATES = new Set([
  "transferred",
  "reboot-incomplete",
  "rebooted",
  "verification-failed",
  "verified",
]);
/** Verified boot states from strongest to weakest (ro.boot.verifiedbootstate). */
const VERIFIED_BOOT_STRENGTH = ["green", "yellow", "orange", "red"];
/** What the operator does on the device; the tool cannot do it over a user build's adb. */
export const OPERATOR_STEPS = Object.freeze({
  enterSideload:
    'On the device, in recovery, choose "Apply update from ADB" with the volume and power keys; the update waits for the device to enter sideload.',
  rebootAfterSideload:
    'When recovery reports that the installation finished, choose "Reboot system now" if the device does not reboot by itself.',
});

/**
 * Problems that keep a compatibility record from being applied on a channel: its
 * kind, recorded problems, product/device/channel, build identity and the channel's
 * OTA certificate and AVB key.
 */
export function releaseRecordProblems(record, channel, label = "release") {
  if (!record || typeof record !== "object")
    return [`${label} record is missing or unreadable`];
  const problems = [];
  if (record.schema !== 1 || record.kind !== RECORD_KIND)
    problems.push(`${label} record is not a schema 1 ${RECORD_KIND} record`);
  if (!Array.isArray(record.problems) || record.problems.length)
    problems.push(
      `${label} record lists problems; a mismatched release is never applied`,
    );
  if (
    !channel ||
    record.product !== channel.product ||
    record.device !== channel.device ||
    record.channel !== channel.channel
  )
    problems.push(
      `${label} is not a ${channel?.channel ?? "channel"} release of ${channel?.product ?? "the product"} on ${channel?.device ?? "its device"}`,
    );
  if (
    typeof record.build?.fingerprint !== "string" ||
    !record.build.fingerprint
  )
    problems.push(`${label} record has no build fingerprint`);
  if (!/^\d+$/.test(record.build?.dateUtc ?? ""))
    problems.push(`${label} record has no build date`);
  if (!SPL.test(record.build?.securityPatch ?? ""))
    problems.push(`${label} record has no security patch level`);
  if (!HEX64.test(record.artifacts?.ota?.sha256 ?? ""))
    problems.push(`${label} record has no OTA package SHA-256`);
  if (!["full", "incremental"].includes(record.artifacts?.ota?.type))
    problems.push(`${label} record has no OTA type`);
  if (!HEX64.test(record.artifacts?.signedTargetFiles?.sha256 ?? ""))
    problems.push(`${label} record has no signed target-files SHA-256`);
  if (
    !HEX64.test(channel?.otaCertificateSha256 ?? "") ||
    record.certificates?.releasekey !== channel.otaCertificateSha256
  )
    problems.push(
      `${label} OTA package certificate is not the channel's otaCertificateSha256`,
    );
  if (
    !HEX64.test(channel?.avbPublicKeySha256 ?? "") ||
    record.verifiedBoot?.publicKeySha256 !== channel.avbPublicKeySha256
  )
    problems.push(`${label} AVB key is not the channel's avbPublicKeySha256`);
  const indexes = record.verifiedBoot?.rollbackIndexes;
  if (
    !Array.isArray(indexes) ||
    !indexes.length ||
    indexes.some(
      (row) =>
        !Number.isSafeInteger(row?.location) ||
        row.location < 0 ||
        !/^\d+$/.test(row?.index ?? ""),
    )
  )
    problems.push(`${label} record has no AVB rollback indexes`);
  for (const flag of RECORD_FLAGS)
    if (record[flag] !== false)
      problems.push(`${label} record claims ${flag}; records never do`);
  return problems;
}

/**
 * Problems with updating a device from the installed release `from` to the
 * candidate `to` on `channel`. Downgrades are refused (newer build date, no lower
 * security patch level, no lower AVB rollback index at any location), the OTA must
 * be verifiable by the installed image (same OTA certificate and AVB key), and an
 * incremental package must start from exactly the installed build. A compatible
 * rollback is a candidate that satisfies these same rules; `observed`, when given,
 * is the device's own reported identity and must be the installed build.
 */
export function updateTransitionProblems({
  from,
  to,
  channel,
  observed = null,
}) {
  const problems = [
    ...releaseRecordProblems(to, channel, "candidate"),
    ...releaseRecordProblems(from, channel, "installed"),
  ];
  if (channel?.downgradeAllowed !== false)
    problems.push(
      "the update channel must refuse downgrades (downgradeAllowed false)",
    );
  if (problems.length) return [...new Set(problems)];
  if (observed) {
    if (observed.device !== channel.device)
      problems.push(`the device is ${observed.device}, not ${channel.device}`);
    if (observed.fingerprint !== from.build.fingerprint)
      problems.push(
        `the device runs ${observed.fingerprint}, not the installed release ${from.build.fingerprint}`,
      );
  }
  if (to.build.fingerprint === from.build.fingerprint)
    problems.push("the candidate is the installed build");
  if (!(BigInt(to.build.dateUtc) > BigInt(from.build.dateUtc)))
    problems.push(
      `candidate build date ${to.build.dateUtc} is not newer than the installed ${from.build.dateUtc}; downgrades are refused`,
    );
  const timestamp = to.payload?.metadata?.["post-timestamp"];
  if (timestamp !== undefined && timestamp !== to.build.dateUtc)
    problems.push("the OTA post-timestamp is not the candidate build date");
  if (to.build.securityPatch < from.build.securityPatch)
    problems.push(
      `candidate security patch ${to.build.securityPatch} is older than the installed ${from.build.securityPatch}`,
    );
  if (
    SPL.test(from.build.vendorSecurityPatch ?? "") &&
    !(
      SPL.test(to.build.vendorSecurityPatch ?? "") &&
      to.build.vendorSecurityPatch >= from.build.vendorSecurityPatch
    )
  )
    problems.push(
      `candidate vendor security patch ${to.build.vendorSecurityPatch} is older than the installed ${from.build.vendorSecurityPatch}`,
    );
  if (from.certificates.releasekey !== to.certificates.releasekey)
    problems.push(
      "the installed image's OTA certificate would not verify the candidate package",
    );
  if (from.verifiedBoot.publicKeySha256 !== to.verifiedBoot.publicKeySha256)
    problems.push("the candidate changes the AVB key the device verifies");
  for (const installed of from.verifiedBoot.rollbackIndexes) {
    const candidate = to.verifiedBoot.rollbackIndexes.find(
      (row) => row.location === installed.location,
    );
    if (!candidate)
      problems.push(
        `the candidate has no AVB rollback index at location ${installed.location}`,
      );
    else if (BigInt(candidate.index) < BigInt(installed.index))
      problems.push(
        `AVB rollback index at location ${installed.location} would fall from ${installed.index} to ${candidate.index}; the device would refuse to boot it`,
      );
  }
  if (to.artifacts.ota.type === "incremental") {
    if (to.payload?.metadata?.["pre-build"] !== from.build.fingerprint)
      problems.push(
        `the incremental OTA starts from ${to.payload?.metadata?.["pre-build"]}, not the installed ${from.build.fingerprint}`,
      );
    if (
      to.artifacts.ota.incrementalFrom?.sha256 !==
      from.artifacts.signedTargetFiles.sha256
    )
      problems.push(
        "the incremental OTA was not built from the installed release's signed target-files",
      );
  }
  return problems;
}

/** `getprop` output (`[key]: [value]` lines) as an object. */
export function parseGetprop(text) {
  const values = {};
  for (const match of String(text).matchAll(/^\[([^\]]+)\]: \[([^\]]*)\]$/gm))
    values[match[1]] = match[2];
  return values;
}

/** Read-only identity of a booted device, from one getprop call and getenforce. */
export function observeBooted(device) {
  const props = parseGetprop(device.adb(["shell", "getprop"]).stdout);
  const slot =
    /^_([ab])$/.exec(props["ro.boot.slot_suffix"] ?? "")?.[1] ?? null;
  return {
    device: props["ro.product.device"] ?? null,
    fingerprint: props["ro.build.fingerprint"] ?? null,
    buildId: props["ro.build.id"] ?? null,
    dateUtc: props["ro.build.date.utc"] ?? null,
    securityPatch: props["ro.build.version.security_patch"] ?? null,
    vendorSecurityPatch: props["ro.vendor.build.security_patch"] ?? null,
    slot,
    bootCompleted: props["sys.boot_completed"] === "1",
    verifiedBootState: props["ro.boot.verifiedbootstate"] ?? null,
    flashLocked: props["ro.boot.flash.locked"] ?? null,
    // Virtual A/B keeps the original slot's dynamic partitions only in snapshots.
    virtualAb: props["ro.virtual_ab.enabled"] === "true",
    selinux: device.adb(["shell", "getenforce"]).stdout.trim(),
  };
}

/** True when `observed` is a weaker verified boot state than `installed` (or unknown). */
export function weakerVerifiedBoot(installed, observed) {
  const before = VERIFIED_BOOT_STRENGTH.indexOf(installed);
  if (before < 0) return false;
  const after = VERIFIED_BOOT_STRENGTH.indexOf(observed);
  return after < 0 || after > before;
}

/**
 * Where the device is: booted Android ("device"), recovery, recovery sideload,
 * the bootloader (seen by fastboot) or absent.
 */
export function deviceState(device) {
  const state = device.adb(["get-state"], { allowFailure: true });
  const reported = state.status === 0 ? state.stdout.trim() : "";
  if (["device", "recovery", "sideload", "rescue"].includes(reported))
    return reported;
  const listed = device.fastbootDevices();
  if (
    listed
      .split(/\r?\n/)
      .some((line) => line.trim().split(/\s+/)[0] === device.serial)
  )
    return "bootloader";
  return reported === "offline" || reported === "unauthorized"
    ? reported
    : "absent";
}

/** Bootloader slot facts (fastboot getvar). Values a bootloader does not report are null. */
export function observeBootloader(device) {
  const variable = (name) => {
    const out = device.fastboot(["getvar", name], { allowFailure: true });
    const text = `${out.stdout ?? ""}\n${out.stderr ?? ""}`;
    const match = new RegExp(
      `^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(\\S+)\\s*$`,
      "m",
    ).exec(text);
    return out.status === 0 && match ? match[1] : null;
  };
  return {
    product: variable("product"),
    currentSlot: variable("current-slot"),
    unlocked: variable("unlocked"),
    snapshotUpdateStatus: variable("snapshot-update-status"),
    slots: Object.fromEntries(
      ["a", "b"].map((slot) => [
        slot,
        {
          successful: variable(`slot-successful:${slot}`),
          unbootable: variable(`slot-unbootable:${slot}`),
          retryCount: variable(`slot-retry-count:${slot}`),
        },
      ]),
    ),
  };
}

/** A device handle over the pinned adb and fastboot binaries for one serial. */
export function deviceRunner({
  serial,
  adb = "adb",
  fastboot = "fastboot",
  env = process.env,
}) {
  if (!SERIAL.test(serial ?? "")) throw new Error("explicit --serial required");
  const run = (
    tool,
    args,
    { allowFailure = false, timeoutMs = 60_000 } = {},
  ) => {
    const out = spawnSync(tool, args, {
      encoding: "utf8",
      env,
      timeout: timeoutMs,
      maxBuffer: 4 << 20,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const result = {
      status: out.error ? null : out.status,
      stdout: out.stdout ?? "",
      stderr: out.stderr ?? "",
    };
    if (!allowFailure && result.status !== 0)
      throw new Error(
        `${path.basename(tool)} ${args[0]} failed (${out.error?.message ?? `status ${out.status}`}): ${result.stderr.trim().slice(0, 512)}`,
      );
    return result;
  };
  return {
    serial,
    adb: (args, options) => run(adb, ["-s", serial, ...args], options),
    fastboot: (args, options) =>
      run(fastboot, ["-s", serial, ...args], options),
    fastbootDevices: () =>
      run(fastboot, ["devices"], { allowFailure: true }).stdout,
  };
}

const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Poll until `predicate(state)` holds or the deadline passes; returns the last state. */
function waitFor(
  device,
  predicate,
  { timeoutMs, wait = sleep, now = Date.now },
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const state = deviceState(device);
    if (predicate(state)) return state;
    if (now() >= deadline) return state;
    wait(2_000);
  }
}

function waitForBoot(device, timing) {
  const state = waitFor(device, (value) => value === "device", timing);
  if (state !== "device") return { state, observed: null };
  const deadline = (timing.now ?? Date.now)() + timing.timeoutMs;
  for (;;) {
    const observed = observeBooted(device);
    if (observed.bootCompleted) return { state, observed };
    if ((timing.now ?? Date.now)() >= deadline) return { state, observed };
    (timing.wait ?? sleep)(2_000);
  }
}

/** Atomically replace the journal (temporary file, fsync, rename, directory fsync). */
export function writeJournal(file, journal) {
  const directory = path.dirname(path.resolve(file));
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.tmp`,
  );
  const fd = fs.openSync(
    temporary,
    fs.constants.O_WRONLY |
      fs.constants.O_CREAT |
      fs.constants.O_EXCL |
      fs.constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fs.writeFileSync(fd, `${JSON.stringify(journal, null, 2)}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temporary, file);
  syncDirectory(directory);
}

export function readJournal(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077)
    throw new Error("the update journal must be a private regular file");
  const journal = JSON.parse(fs.readFileSync(file, "utf8"));
  if (journal?.schema !== 1 || journal.kind !== JOURNAL_KIND)
    throw new Error(`${file} is not an ${JOURNAL_KIND}`);
  return journal;
}

function event(journal, state, details = {}, now = () => new Date()) {
  journal.state = state;
  journal.events.push({ at: now().toISOString(), state, ...details });
  return journal;
}

/**
 * Classify a journaled update from the observed device. Returns the next safe
 * step: "verify" (the candidate booted), "sideload" (the device waits in recovery
 * sideload or recovery), "retry" (the device still runs the installed build on its
 * original slot: the update did not take effect or the bootloader fell back),
 * "bootloader" (inspect slots; fastboot reboot or fallback), "absent" or "refuse".
 */
export function classifyUpdate(journal, state, observed) {
  if (state === "sideload" || state === "recovery")
    return { next: "sideload", reason: `the device is in ${state}` };
  if (state === "bootloader")
    return {
      next: "bootloader",
      reason:
        "the device is in its bootloader; inspect slot health before rebooting",
    };
  if (state !== "device")
    return {
      next: "absent",
      reason: `the device is ${state}; the update outcome cannot be observed`,
    };
  if (!observed?.bootCompleted)
    return { next: "absent", reason: "Android has not finished booting" };
  if (observed.device !== journal.release.device)
    return { next: "refuse", reason: `the device is ${observed.device}` };
  if (observed.fingerprint === journal.release.fingerprint)
    return { next: "verify", reason: "the candidate build is running" };
  if (observed.fingerprint === journal.from.fingerprint) {
    if (observed.slot === journal.from.slot)
      return {
        next: "retry",
        reason:
          "the installed build still runs on its original slot: the update did not take effect, or the bootloader fell back",
      };
    return {
      next: "refuse",
      reason: "the installed build runs on the other slot; inspect the device",
    };
  }
  return {
    next: "refuse",
    reason: `the device runs ${observed.fingerprint}, neither the installed nor the candidate build`,
  };
}

/** Checks the booted candidate must pass: build, slot switch, SELinux, verified boot not weakened. */
export function verifyAppliedUpdate(journal, observed) {
  const problems = [];
  if (!observed?.bootCompleted)
    problems.push("Android has not finished booting");
  if (observed?.device !== journal.release.device)
    problems.push(`the device is ${observed?.device}`);
  if (observed?.fingerprint !== journal.release.fingerprint)
    problems.push(`the device runs ${observed?.fingerprint}`);
  if (!observed?.slot || observed.slot === journal.from.slot)
    problems.push("the update did not switch the active slot");
  if (observed?.selinux !== "Enforcing")
    problems.push("SELinux is not enforcing");
  if (journal.from.flashLocked === "1" && observed?.flashLocked !== "1")
    problems.push("the bootloader is no longer locked");
  // A product key enrolled with avb_custom_key boots yellow; it must not become orange or red.
  if (
    weakerVerifiedBoot(
      journal.from.verifiedBootState,
      observed?.verifiedBootState,
    )
  )
    problems.push(
      `verified boot is ${observed?.verifiedBootState}, weaker than the installed ${journal.from.verifiedBootState} state`,
    );
  if (observed?.securityPatch !== journal.release.securityPatch)
    problems.push(
      `the device reports security patch ${observed?.securityPatch}, not ${journal.release.securityPatch}`,
    );
  return problems;
}

function readRecordFile(file) {
  const bytes = fs.readFileSync(file);
  return { record: JSON.parse(bytes), sha256: sha256(bytes) };
}

/**
 * Apply (or resume) one journaled update. Without `execute` it only observes and
 * returns the plan and problems. With `execute`, `confirm` must be true; the
 * device lock (install-lock.ts) prevents a concurrent install or update of the same
 * serial, and an interrupted run leaves it for the operator to inspect. `notify`
 * receives the steps the operator performs on the device (OPERATOR_STEPS): a user
 * build's recovery is entered with `adb reboot recovery` and sideload is chosen on
 * the device, because `adb reboot sideload` needs a root adbd.
 */
export function applyUpdate({
  device,
  channel,
  from,
  to,
  ota,
  journalFile,
  execute = false,
  confirm = false,
  timing = {},
  lockDirectory,
  now = () => new Date(),
  notify = (message) => console.error(message),
}) {
  const timeouts = {
    reboot: timing.rebootMs ?? 10 * 60_000,
    operator: timing.operatorMs ?? 10 * 60_000,
    sideload: timing.sideloadMs ?? 60 * 60_000,
    wait: timing.wait,
    now: timing.now,
  };
  const installed = readRecordFile(from),
    candidate = readRecordFile(to);
  const problems = updateTransitionProblems({
    from: installed.record,
    to: candidate.record,
    channel,
  });
  const ownedPackage = hashFile(ota);
  if (
    ownedPackage.sha256 !== candidate.record.artifacts?.ota?.sha256 ||
    ownedPackage.sizeBytes !== candidate.record.artifacts?.ota?.sizeBytes
  )
    problems.push(
      "the OTA package is not the one the candidate record describes",
    );
  let journal = fs.existsSync(journalFile) ? readJournal(journalFile) : null;
  if (
    journal &&
    (journal.serial !== device.serial ||
      journal.release.otaSha256 !== ownedPackage.sha256 ||
      journal.release.recordSha256 !== candidate.sha256 ||
      journal.from.recordSha256 !== installed.sha256)
  )
    problems.push(
      "the journal belongs to another device, package or release; start a new journal",
    );
  const state = deviceState(device);
  const observed = state === "device" ? observeBooted(device) : null;
  if (!journal) {
    if (state !== "device" || !observed?.bootCompleted)
      problems.push(
        `a new update starts from booted Android; the device is ${state}`,
      );
    else
      problems.push(
        ...updateTransitionProblems({
          from: installed.record,
          to: candidate.record,
          channel,
          observed,
        }).filter((problem) => /^the device /.test(problem)),
      );
    if (observed && !observed.slot)
      problems.push("the device reports no A/B slot");
    if (observed && observed.selinux !== "Enforcing")
      problems.push("SELinux is not enforcing on the installed build");
  }
  const classification = journal
    ? classifyUpdate(journal, state, observed)
    : null;
  const plan = {
    serial: device.serial,
    from: installed.record.build.fingerprint,
    to: candidate.record.build.fingerprint,
    otaSha256: ownedPackage.sha256,
    type: candidate.record.artifacts.ota.type,
    deviceState: state,
    journalState: journal?.state ?? null,
    next: classification?.next ?? "sideload",
    reason: classification?.reason ?? "start the update",
  };
  if (classification?.next === "refuse")
    problems.push(`refusing to continue: ${classification.reason}`);
  // A fallback is the operator's decision against this update; trying it again starts a new journal.
  if (journal?.state === "rolled-back")
    problems.push(
      "the journal records a fallback to the original slot; start a new journal to update again",
    );
  if (!execute || problems.length)
    return { executed: false, plan, problems: [...new Set(problems)] };
  if (!confirm)
    throw new Error("--execute applies an OS update; add --confirm-update");
  if (journal && journal.state === "verified")
    return { executed: false, plan, problems: [], journal };
  return withDeviceInstallLock(
    device.serial,
    { operation: "ota-update", otaSha256: ownedPackage.sha256 },
    (lock) => {
      if (!journal) {
        journal = {
          schema: 1,
          kind: JOURNAL_KIND,
          serial: device.serial,
          createdAt: now().toISOString(),
          release: {
            product: candidate.record.product,
            device: candidate.record.device,
            channel: candidate.record.channel,
            fingerprint: candidate.record.build.fingerprint,
            securityPatch: candidate.record.build.securityPatch,
            type: candidate.record.artifacts.ota.type,
            otaFile: path.basename(ota),
            otaSha256: ownedPackage.sha256,
            recordSha256: candidate.sha256,
          },
          from: {
            fingerprint: observed.fingerprint,
            slot: observed.slot,
            securityPatch: observed.securityPatch,
            verifiedBootState: observed.verifiedBootState,
            flashLocked: observed.flashLocked,
            virtualAb: observed.virtualAb === true,
            recordSha256: installed.sha256,
          },
          state: "preflight",
          events: [],
          signedUpdateApplied: false,
          drillRecorded: false,
        };
        const fd = fs.openSync(
          journalFile,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        fs.closeSync(fd);
        writeJournal(
          journalFile,
          event(journal, "preflight", { observed }, now),
        );
      }
      let next = classification?.next ?? "sideload";
      let current = state;
      if (next === "bootloader" || next === "absent")
        throw new Error(
          `${classification.reason}; run status, then reboot or fall back explicitly`,
        );
      if (next === "retry") {
        writeJournal(
          journalFile,
          event(
            journal,
            "interrupted",
            { reason: classification.reason, observed },
            now,
          ),
        );
        next = "sideload";
      }
      if (next === "sideload") {
        lock.beforeWrites();
        if (current !== "sideload") {
          // A user build's adbd refuses `reboot sideload` (it needs adb root): enter
          // recovery and let the operator choose sideload on the device.
          if (current === "device") device.adb(["reboot", "recovery"]);
          writeJournal(
            journalFile,
            event(journal, "recovery", { deviceState: current }, now),
          );
          notify(OPERATOR_STEPS.enterSideload);
          current = waitFor(device, (value) => value === "sideload", {
            timeoutMs: timeouts.reboot + timeouts.operator,
            wait: timeouts.wait,
            now: timeouts.now,
          });
          if (current !== "sideload") {
            writeJournal(
              journalFile,
              event(
                journal,
                "sideload-unavailable",
                { deviceState: current },
                now,
              ),
            );
            throw new Error(
              `the device did not enter recovery sideload (it is ${current}); nothing was sent. Choose "Apply update from ADB" in recovery and run apply again, or reboot the device`,
            );
          }
        }
        writeJournal(journalFile, event(journal, "sideload", {}, now));
        const transfer = device.adb(["sideload", path.resolve(ota)], {
          allowFailure: true,
          timeoutMs: timeouts.sideload,
        });
        if (transfer.status !== 0) {
          writeJournal(
            journalFile,
            event(
              journal,
              "transfer-failed",
              {
                status: transfer.status,
                stderr: transfer.stderr.trim().slice(0, 1024),
              },
              now,
            ),
          );
          throw new Error(
            "recovery did not complete the OTA transfer; the journal records the failure. Run status: a repeated apply resumes only from the device state it observes",
          );
        }
        writeJournal(journalFile, event(journal, "transferred", {}, now));
        // Recovery leaves sideload when the installation ends; a user build's recovery
        // then has no adb, so the operator may have to choose the reboot.
        device.adb(["reboot"], { allowFailure: true });
        notify(OPERATOR_STEPS.rebootAfterSideload);
        const booted = waitForBoot(device, {
          timeoutMs: timeouts.reboot + timeouts.operator,
          wait: timeouts.wait,
          now: timeouts.now,
        });
        if (!booted.observed?.bootCompleted) {
          writeJournal(
            journalFile,
            event(
              journal,
              "reboot-incomplete",
              { deviceState: booted.state },
              now,
            ),
          );
          throw new Error(
            `Android did not finish booting after the update (device ${booted.state}); run status`,
          );
        }
        writeJournal(
          journalFile,
          event(journal, "rebooted", { observed: booted.observed }, now),
        );
        current = "device";
        const verdict = classifyUpdate(journal, current, booted.observed);
        if (verdict.next === "retry") {
          writeJournal(
            journalFile,
            event(
              journal,
              "interrupted",
              { reason: verdict.reason, observed: booted.observed },
              now,
            ),
          );
          throw new Error(
            "the device rebooted into the installed build; the update did not take effect",
          );
        }
      }
      const final = observeBooted(device);
      const failures = verifyAppliedUpdate(journal, final);
      if (failures.length) {
        writeJournal(
          journalFile,
          event(
            journal,
            "verification-failed",
            { failures, observed: final },
            now,
          ),
        );
        throw new Error(
          `the updated device failed verification:\n${failures.map((item) => `  - ${item}`).join("\n")}`,
        );
      }
      journal.signedUpdateApplied = true;
      writeJournal(
        journalFile,
        event(journal, "verified", { observed: final }, now),
      );
      return { executed: true, plan, problems: [], journal };
    },
    lockDirectory,
  );
}

/** Read-only journal status against the observed device. */
export function updateStatus({ device, journalFile }) {
  const journal = readJournal(journalFile);
  if (journal.serial !== device.serial)
    throw new Error("the journal belongs to another device");
  const state = deviceState(device);
  const observed = state === "device" ? observeBooted(device) : null;
  const bootloader = state === "bootloader" ? observeBootloader(device) : null;
  return {
    journalState: journal.state,
    deviceState: state,
    observed,
    bootloader,
    ...classifyUpdate(journal, state, observed),
  };
}

/**
 * Problems with falling back to the slot the update started from. Fallback is only
 * admitted while the updated slot has not been marked successful (so the stored
 * AVB rollback indexes still admit the original build), the original slot is not
 * marked unbootable, and no snapshot merge is in progress. On a Virtual A/B device
 * the original slot's dynamic partitions survive only in an unmerged snapshot
 * update: when recovery could not create snapshots it overwrites them, so the
 * bootloader must report `snapshotted`. After that, recover with a compatible
 * rollback release (`check`) or the stock factory image.
 */
export function fallbackProblems(journal, bootloader) {
  const problems = [];
  if (!FALLBACK_STATES.has(journal.state))
    problems.push(
      `the journal is ${journal.state}; no updated slot to fall back from`,
    );
  const original = journal.from.slot;
  const updated = original === "a" ? "b" : original === "b" ? "a" : null;
  if (!updated) problems.push("the journal records no original slot");
  if (bootloader.currentSlot !== updated)
    problems.push(
      `the bootloader's current slot is ${bootloader.currentSlot}, not the updated slot ${updated}`,
    );
  if (bootloader.slots?.[updated]?.successful !== "no")
    problems.push(
      `the updated slot is marked successful (${bootloader.slots?.[updated]?.successful}); its rollback indexes may already be stored, so the original build may no longer boot`,
    );
  if (bootloader.slots?.[original]?.unbootable !== "no")
    problems.push(
      `the original slot ${original} is not reported bootable (${bootloader.slots?.[original]?.unbootable})`,
    );
  if (bootloader.snapshotUpdateStatus === "merging")
    problems.push(
      "a snapshot merge is in progress; the original slot is being overwritten",
    );
  else if (
    journal.from?.virtualAb !== false &&
    bootloader.snapshotUpdateStatus !== "snapshotted"
  )
    problems.push(
      `the bootloader reports snapshot update status ${bootloader.snapshotUpdateStatus}, not snapshotted; on a Virtual A/B device the original slot's dynamic partitions may have been overwritten, so recover with a compatible release or the stock factory image`,
    );
  return problems;
}

/** Fall back to the original slot from the bootloader, then verify the installed build booted. */
export function fallbackToOriginalSlot({
  device,
  journalFile,
  execute = false,
  confirm = false,
  timing = {},
  lockDirectory,
  now = () => new Date(),
}) {
  const journal = readJournal(journalFile);
  if (journal.serial !== device.serial)
    throw new Error("the journal belongs to another device");
  const state = deviceState(device);
  if (state !== "bootloader")
    return {
      executed: false,
      problems: [
        `the device is ${state}; enter the bootloader first (adb reboot bootloader, or the key combination when Android does not boot)`,
      ],
    };
  const bootloader = observeBootloader(device);
  const problems = fallbackProblems(journal, bootloader);
  if (!execute || problems.length)
    return { executed: false, bootloader, problems };
  if (!confirm)
    throw new Error(
      "--execute changes the active slot; add --confirm-fallback",
    );
  return withDeviceInstallLock(
    device.serial,
    { operation: "ota-fallback" },
    (lock) => {
      lock.beforeWrites();
      writeJournal(
        journalFile,
        event(journal, "fallback-started", { bootloader }, now),
      );
      device.fastboot(["set_active", journal.from.slot]);
      const after = observeBootloader(device);
      if (after.currentSlot !== journal.from.slot) {
        writeJournal(
          journalFile,
          event(journal, "fallback-failed", { bootloader: after }, now),
        );
        throw new Error("the bootloader did not switch to the original slot");
      }
      device.fastboot(["reboot"], { allowFailure: true });
      const booted = waitForBoot(device, {
        timeoutMs: timing.rebootMs ?? 10 * 60_000,
        wait: timing.wait,
        now: timing.now,
      });
      const observed = booted.observed;
      const failures = [];
      if (!observed?.bootCompleted)
        failures.push(
          `Android did not finish booting (device ${booted.state})`,
        );
      else {
        if (observed.fingerprint !== journal.from.fingerprint)
          failures.push(
            `the device runs ${observed.fingerprint}, not the installed ${journal.from.fingerprint}`,
          );
        if (observed.slot !== journal.from.slot)
          failures.push(`the device booted slot ${observed.slot}`);
        if (observed.selinux !== "Enforcing")
          failures.push("SELinux is not enforcing");
      }
      if (failures.length) {
        writeJournal(
          journalFile,
          event(journal, "fallback-failed", { failures, observed }, now),
        );
        throw new Error(
          `fallback did not restore the installed build:\n${failures.map((item) => `  - ${item}`).join("\n")}`,
        );
      }
      journal.signedUpdateApplied = false;
      writeJournal(
        journalFile,
        event(journal, "rolled-back", { observed }, now),
      );
      return { executed: true, problems: [], journal };
    },
    lockDirectory,
  );
}

/**
 * Verify the stock factory archive a channel retains for recovery and return the
 * exact fastboot plan. Stock recovery unlocks the bootloader and wipes user data;
 * the operator runs it with physical confirmation on the device. It is never
 * executed by this tool.
 */
export function stockRecoveryPlan({ channel, sourceLock, archive, entries }) {
  const problems = [];
  const stock = channel?.recovery?.stockFactoryImage;
  if (
    !stock ||
    stock.sha256 !== sourceLock?.factory?.sha256 ||
    stock.filename !== sourceLock?.factory?.filename
  )
    problems.push(
      "the channel's stock image is not the locked factory archive",
    );
  if (path.basename(archive) !== stock?.filename)
    problems.push(`the archive is not named ${stock?.filename}`);
  const actual = hashFile(archive);
  if (actual.sha256 !== stock?.sha256)
    problems.push(
      "the archive SHA-256 is not the channel's stock factory image",
    );
  if (
    sourceLock?.factory?.sizeBytes &&
    actual.sizeBytes !== sourceLock.factory.sizeBytes
  )
    problems.push("the archive size is not the locked factory archive size");
  const device = channel?.device;
  const names = entries ?? [];
  const roots = new Set(names.map((name) => name.split("/")[0]));
  const prefix = roots.size === 1 ? [...roots][0] : null;
  if (!prefix)
    problems.push("the archive does not have one top-level directory");
  const one = (pattern, what) => {
    const found = names.filter((name) => pattern.test(name));
    if (found.length !== 1) {
      problems.push(`the archive has ${found.length} ${what} entries, not one`);
      return null;
    }
    return found[0];
  };
  const escaped = String(device).replace(/[^a-z0-9_-]/g, "");
  const bootloader = one(
    new RegExp(`^[^/]+/bootloader-${escaped}-[^/]+\\.img$`),
    "bootloader",
  );
  const radio = one(
    new RegExp(`^[^/]+/radio-${escaped}-[^/]+\\.img$`),
    "radio",
  );
  const image = one(
    new RegExp(`^[^/]+/image-${escaped}-[^/]+\\.zip$`),
    "system image",
  );
  const buildId = sourceLock?.factory?.buildId?.toLowerCase();
  if (image && buildId && !image.toLowerCase().includes(buildId))
    problems.push(
      `the system image is not build ${sourceLock.factory.buildId}`,
    );
  const serial = "SERIAL";
  const steps = [
    ["adb", "-s", serial, "reboot", "bootloader"],
    ["fastboot", "-s", serial, "flashing", "unlock"],
    ["fastboot", "-s", serial, "erase", "avb_custom_key"],
    ["fastboot", "-s", serial, "flash", "bootloader", bootloader],
    ["fastboot", "-s", serial, "reboot-bootloader"],
    ["fastboot", "-s", serial, "flash", "radio", radio],
    ["fastboot", "-s", serial, "reboot-bootloader"],
    ["fastboot", "-s", serial, "-w", "update", image],
  ];
  return {
    archive: { file: path.basename(archive), ...actual },
    buildId: sourceLock?.factory?.buildId ?? null,
    steps: problems.length ? [] : steps,
    notes: [
      "Extract the verified archive into a new directory and run the steps from it.",
      "flashing unlock is refused unless OEM unlocking was enabled in the running image's developer options; a device that no longer boots cannot enable it, so the drill checks it first.",
      "flashing unlock and -w update erase all user data; the device asks for physical confirmation.",
      "Relock (fastboot flashing lock, which wipes again) only after verify-stock passes.",
      "This restores Google's stock image; it is not a signed update or rollback of the product.",
    ],
    problems,
    executed: false,
  };
}

/** Read-only check that a device runs the channel's stock factory build. */
export function verifyStockRecovery({
  device,
  sourceLock,
  codename = "stallion",
}) {
  const state = deviceState(device);
  if (state !== "device")
    return { passed: false, problems: [`the device is ${state}`] };
  const observed = observeBooted(device);
  const problems = [];
  const buildId = sourceLock?.factory?.buildId;
  if (!observed.bootCompleted)
    problems.push("Android has not finished booting");
  if (observed.device !== codename)
    problems.push(`the device is ${observed.device}`);
  if (
    !observed.fingerprint?.startsWith(`google/${codename}/${codename}:`) ||
    !observed.fingerprint.includes(`/${buildId}/`) ||
    !observed.fingerprint.endsWith(":user/release-keys")
  )
    problems.push(
      `the device runs ${observed.fingerprint}, not stock ${buildId}`,
    );
  if (observed.selinux !== "Enforcing")
    problems.push("SELinux is not enforcing");
  if (observed.flashLocked === "1" && observed.verifiedBootState !== "green")
    problems.push(
      `a locked bootloader reports ${observed.verifiedBootState} verified boot`,
    );
  return {
    passed: problems.length === 0,
    observed,
    problems,
    scope: "Stock build identity after recovery; not hardware acceptance",
  };
}

function archiveEntries(archive) {
  const out = spawnSync("unzip", ["-Z1", archive], {
    encoding: "utf8",
    maxBuffer: 16 << 20,
  });
  if (out.status !== 0) throw new Error("the archive could not be listed");
  return out.stdout.split(/\r?\n/).filter(Boolean);
}

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));

export function parseArgs(argv) {
  const [command, ...rest] = argv;
  const values = {
    "--serial": "serial",
    "--channel": "channel",
    "--from": "from",
    "--to": "to",
    "--ota": "ota",
    "--journal": "journal",
    "--source-lock": "sourceLock",
    "--archive": "archive",
    "--adb": "adb",
    "--fastboot": "fastboot",
  };
  const flags = {
    "--execute": "execute",
    "--confirm-update": "confirmUpdate",
    "--confirm-fallback": "confirmFallback",
  };
  const options = { command };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (flags[arg]) {
      if (options[flags[arg]]) throw new Error(`duplicate ${arg}`);
      options[flags[arg]] = true;
    } else if (values[arg]) {
      if (options[values[arg]] !== undefined)
        throw new Error(`duplicate ${arg}`);
      if (!rest[i + 1] || rest[i + 1].startsWith("--"))
        throw new Error(`${arg} needs a value`);
      options[values[arg]] = rest[++i];
    } else throw new Error(`unsupported option ${arg}`);
  }
  const required = {
    check: ["channel", "from", "to"],
    apply: ["serial", "channel", "from", "to", "ota", "journal"],
    status: ["serial", "journal"],
    fallback: ["serial", "journal"],
    "stock-archive": ["channel", "sourceLock", "archive"],
    "verify-stock": ["serial", "sourceLock"],
  }[command];
  if (!required)
    throw new Error(
      "Use check | apply | status | fallback | stock-archive | verify-stock (see the header of aosp-ota-update.mjs)",
    );
  for (const name of required)
    if (!options[name])
      throw new Error(
        `${command} requires --${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`,
      );
  if (options.confirmUpdate && (command !== "apply" || !options.execute))
    throw new Error("--confirm-update belongs to apply --execute");
  if (options.confirmFallback && (command !== "fallback" || !options.execute))
    throw new Error("--confirm-fallback belongs to fallback --execute");
  if (options.execute && !["apply", "fallback"].includes(command))
    throw new Error(`${command} is read-only`);
  return options;
}

/** CLI. A brand wrapper passes its channel and source lock as defaults. */
export function main(argv = process.argv.slice(2), defaults = {}) {
  const [command] = argv;
  const withDefaults = [...argv];
  if (
    defaults.channel &&
    !argv.includes("--channel") &&
    ["check", "apply", "stock-archive"].includes(command)
  )
    withDefaults.push("--channel", defaults.channel);
  if (
    defaults.sourceLock &&
    !argv.includes("--source-lock") &&
    ["stock-archive", "verify-stock"].includes(command)
  )
    withDefaults.push("--source-lock", defaults.sourceLock);
  const options = parseArgs(withDefaults);
  const channel = options.channel ? readJson(options.channel) : null;
  const device = options.serial
    ? deviceRunner({
        serial: options.serial,
        adb: options.adb,
        fastboot: options.fastboot,
      })
    : null;
  let result;
  switch (options.command) {
    case "check":
      result = {
        problems: updateTransitionProblems({
          from: readJson(options.from),
          to: readJson(options.to),
          channel,
        }),
      };
      break;
    case "apply":
      result = applyUpdate({
        device,
        channel,
        from: options.from,
        to: options.to,
        ota: options.ota,
        journalFile: options.journal,
        execute: options.execute === true,
        confirm: options.confirmUpdate === true,
      });
      break;
    case "status":
      result = updateStatus({ device, journalFile: options.journal });
      break;
    case "fallback":
      result = fallbackToOriginalSlot({
        device,
        journalFile: options.journal,
        execute: options.execute === true,
        confirm: options.confirmFallback === true,
      });
      break;
    case "stock-archive":
      result = stockRecoveryPlan({
        channel,
        sourceLock: readJson(options.sourceLock),
        archive: options.archive,
        entries: archiveEntries(options.archive),
      });
      break;
    case "verify-stock":
      result = verifyStockRecovery({
        device,
        sourceLock: readJson(options.sourceLock),
      });
      break;
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.problems?.length || result.passed === false) process.exitCode = 1;
  return result;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
