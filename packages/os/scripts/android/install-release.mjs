#!/usr/bin/env node
/** Qualified, serial-bound OS installation. No firmware flashing or relocking. */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFastbootInfoArtifacts } from "../aosp/build-grizzly-bundle.mjs";
import { withDeviceInstallLock } from "./install-lock.mjs";
import { readHealthToken, verifyPostBoot } from "./post-boot.mjs";
import {
  canonical,
  hashFile,
  loadPolicy,
  readJson,
  requireThat,
  sha256,
  validateEnvelope,
  verifyFile,
  verifyInstallFiles,
} from "./release-contract.mjs";
import { readAndroidHealth } from "./runtime-health.mjs";

export function parseOptions(argv) {
  const o = { execute: false, confirm: false, wipe: false, reboot: false };
  const values = {
    "--manifest": "manifest",
    "--artifact-dir": "directory",
    "--device": "serial",
    "--slot": "slot",
    "--journal": "journal",
    "--tool-dir": "toolDir",
    "--recovery-dir": "recoveryDir",
    "--health-token-file": "healthTokenFile",
  };
  const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    requireThat(!seen.has(a), `duplicate argument ${a}`);
    seen.add(a);
    if (values[a]) {
      requireThat(argv[i + 1] && !argv[i + 1].startsWith("--"), `missing ${a}`);
      o[values[a]] = argv[++i];
    } else if (a === "--execute") o.execute = true;
    else if (a === "--confirm-flash") o.confirm = true;
    else if (a === "--wipe-data") o.wipe = true;
    else if (a === "--reboot-after-flash") o.reboot = true;
    else if (a === "--dry-run") {
      requireThat(!o.execute, "conflicting execution flags");
    } else if (a !== "--assume-bootloader")
      throw new Error(`unsupported signed-install option: ${a}`);
  }
  requireThat(
    !(seen.has("--dry-run") && o.execute),
    "conflicting execution flags",
  );
  requireThat(
    o.manifest && o.directory,
    "--manifest and --artifact-dir required",
  );
  requireThat(!o.confirm || o.execute, "--confirm-flash requires --execute");
  return o;
}

export function assertExecutionOptions(o) {
  if (o.confirm)
    requireThat(
      o.serial &&
        /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(o.serial) &&
        o.journal &&
        o.toolDir &&
        o.recoveryDir,
      "confirmed installation requires --device, --journal, --tool-dir and --recovery-dir",
    );
}

export function compilePlan(
  release,
  fastbootInfo,
  state,
  { wipe = false, reboot = false } = {},
) {
  requireThat(
    release.startingStates.some((s) => canonical(s) === canonical(state)),
    "unqualified starting state",
  );
  requireThat(
    wipe === state.wipeRequired,
    "wipe choice does not match qualified transition",
  );
  const other = state.targetSlot === "a" ? "b" : "a";
  const plan = [];
  for (const c of parseFastbootInfoArtifacts(fastbootInfo).commands) {
    if (c.command === "version") continue;
    if (c.command === "flash")
      plan.push({
        mode: plan.some((p) => p.mode === "fastbootd")
          ? "fastbootd"
          : "bootloader",
        args: [
          "--slot",
          c.flags.includes("--slot-other") ? other : state.targetSlot,
          "flash",
          c.partition,
          c.filename,
        ],
        file: c.filename,
      });
    else if (c.command === "reboot" && c.tokens[0] === "fastboot")
      plan.push({
        mode: "bootloader",
        args: ["reboot", "fastboot"],
        transition: "fastbootd",
      });
    else if (c.command === "reboot")
      continue; // Reboot is an explicit operator choice after verification.
    else if (c.command === "update-super")
      plan.push({
        mode: "fastbootd",
        args: ["update-super", "super_empty.img", ...(wipe ? ["wipe"] : [])],
        file: "super_empty.img",
      });
    else if (c.command === "if-wipe") {
      if (wipe) plan.push({ mode: "fastbootd", args: ["erase", c.tokens[1]] });
    } else throw new Error(`unsupported executable task ${c.command}`);
  }
  // Always return to the bootloader before final activation. Never lock it.
  plan.push({
    mode: "fastbootd",
    args: ["reboot", "bootloader"],
    transition: "bootloader",
  });
  plan.push({ mode: "bootloader", args: [`--set-active=${state.targetSlot}`] });
  if (reboot)
    plan.push({ mode: "bootloader", args: ["reboot"], transition: "adb" });
  return plan;
}
export function parseGetvar(output, key) {
  const values = output
    .split(/\r?\n/)
    .map((l) => l.replace(/^\(bootloader\)\s*/, ""))
    .filter((l) => l.startsWith(`${key}:`))
    .map((l) => l.slice(key.length + 1).trim());
  requireThat(
    values.length === 1 && values[0].length > 0,
    `missing/ambiguous getvar ${key}`,
  );
  return values[0];
}
export function checkedRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 30000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      ANDROID_SERIAL: undefined,
      FASTBOOT_FORCE_FLASH: undefined,
    },
    ...options,
  });
  requireThat(
    !result.error && result.status === 0,
    `command failed (${result.status ?? result.error?.code}): ${path.basename(command)} ${JSON.stringify(args)}\n${result.stderr ?? ""}`,
  );
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}
export function toolPaths(dir, release, run) {
  const tools = {};
  for (const name of ["adb", "fastboot"]) {
    tools[name] = fs.realpathSync(path.join(dir, name));
    requireThat(
      hashFile(tools[name]).sha256 === release.tools[name].sha256,
      `${name} digest mismatch`,
    );
    requireThat(
      run(tools[name], ["--version"]).includes(release.tools[name].version),
      `${name} version mismatch`,
    );
  }
  return tools;
}

// Verify immediately before every subprocess, including read-only discovery.
// A previous check is insufficient when the tool changes between commands.
export function pinnedToolRunner(tools, release, run = checkedRun) {
  return (command, args, options) => {
    const name = Object.keys(tools).find((key) => tools[key] === command);
    requireThat(name && release.tools[name], "unqualified tool invocation");
    requireThat(
      hashFile(command).sha256 === release.tools[name].sha256,
      `${name} changed during installation`,
    );
    return run(command, args, options);
  };
}

export function deviceReader(tools, serial, run) {
  requireThat(
    typeof run === "function",
    "device reader requires a checked transport",
  );
  const fb = (args, options = {}) =>
    run(tools.fastboot, ["-s", serial, ...args], options);
  const get = (key) => parseGetvar(fb(["getvar", key]), key);
  return {
    fb,
    get,
    mode(expected, release) {
      const inventory = run(tools.fastboot, ["devices"])
        .trim()
        .split(/\r?\n/)
        .map((l) => l.trim().split(/\s+/));
      requireThat(
        inventory.filter((row) => row[0] === serial && row[1] === "fastboot")
          .length === 1,
        "selected serial absent from fastboot",
      );
      requireThat(
        get("product") === release.target.codename,
        "device product changed",
      );
      requireThat(
        ["yes", "true"].includes(get("unlocked")),
        "device is locked",
      );
      requireThat(
        get("is-userspace") === (expected === "fastbootd" ? "yes" : "no"),
        "wrong fastboot mode",
      );
      requireThat(
        get("snapshot-update-status") === "none",
        "pending/unknown snapshot state",
      );
    },
    inspect(release) {
      this.mode("bootloader", release);
      const sku = get("sku");
      requireThat(release.target.skus.includes(sku), "unqualified SKU");
      const storage = get("partition-size:userdata");
      requireThat(
        /^0x[0-9a-fA-F]+$/.test(storage) &&
          release.target.storageBytes.includes(BigInt(storage).toString()),
        "unqualified userdata capacity",
      );
      const level = get("battery-level");
      requireThat(
        /^\d+$/.test(level) &&
          Number(level) <= 100 &&
          Number(level) >= release.minimumBatteryPercent,
        "low/unknown battery",
      );
      const bl = get("version-bootloader"),
        radio = get("version-baseband"),
        slot = get("current-slot");
      const states = release.startingStates.filter(
        (s) =>
          s.bootloader === bl && s.baseband === radio && s.currentSlot === slot,
      );
      requireThat(
        states.length === 1,
        "firmware/slot starting state is unknown or ambiguous",
      );
      const state = states[0];
      for (const [k, v] of Object.entries(state.getvars))
        requireThat(get(k) === v, `starting state mismatch: ${k}`);
      for (const [p, size] of Object.entries(release.geometry.partitionSizes)) {
        const actual = get(`partition-size:${p}`);
        requireThat(
          /^0x[0-9a-fA-F]+$/.test(actual) && BigInt(actual) === BigInt(size),
          `partition geometry mismatch: ${p}`,
        );
      }
      return state;
    },
  };
}

export function waitUntil(check, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      Atomics.wait(
        new Int32Array(new SharedArrayBuffer(4)),
        0,
        0,
        Math.min(500, deadline - Date.now()),
      );
    }
  }
}

export function executePlan({
  release,
  state,
  plan,
  reader,
  stage,
  journal,
  tools,
  serial,
  run = checkedRun,
  healthToken,
  requestHealth = (token) => readAndroidHealth(tools.adb, serial, token),
}) {
  const record = (event) => {
    fs.writeSync(
      journal,
      `${JSON.stringify({ ...event, time: new Date().toISOString() })}\n`,
    );
    fs.fsyncSync(journal);
  };
  try {
    requireThat(
      state &&
        release.startingStates.some((s) => canonical(s) === canonical(state)),
      "execution requires a qualified starting state",
    );
    let activeSlot = state.currentSlot;
    const checkState = () => {
      requireThat(
        reader.get("current-slot") === activeSlot,
        "active slot changed during installation",
      );
      requireThat(
        reader.get("version-bootloader") === state.bootloader,
        "bootloader changed during installation",
      );
      requireThat(
        reader.get("version-baseband") === state.baseband,
        "baseband changed during installation",
      );
    };
    for (const [index, step] of plan.entries()) {
      requireThat(
        hashFile(tools.fastboot).sha256 === release.tools.fastboot.sha256,
        "fastboot changed during installation",
      );
      const args = [...step.args];
      if (step.file)
        args[args.indexOf(step.file)] = verifyFile(
          stage,
          release.files.find((f) => f.filename === step.file),
        );
      // Hashing a multi-gigabyte image can take minutes. Query live device
      // state afterwards, immediately before authorizing the next command.
      reader.mode(step.mode, release);
      checkState();
      if (step.args[0].startsWith("--set-active="))
        requireThat(
          step.args[0] === `--set-active=${state.targetSlot}`,
          "activation conflicts with qualified target slot",
        );
      record({ event: "begin", index, args });
      const output = reader.fb(args, {
        timeoutMs: release.validation.flashTimeoutSeconds * 1000,
      });
      record({ event: "command-complete", index, output });
      if (step.args[0].startsWith("--set-active=")) {
        activeSlot = state.targetSlot;
        checkState();
        record({ event: "active-slot-verified", slot: activeSlot });
      }
      if (step.transition && step.transition !== "adb") {
        // Fastboot reconnect is bounded by each command's timeout; wrong or
        // missing state fails closed. Operators may retry after inspection.
        waitUntil(() => reader.mode(step.transition, release), 30000);
        checkState();
      }
    }
    if (plan.at(-1)?.transition === "adb") {
      run = pinnedToolRunner(tools, release, run);
      requireThat(
        hashFile(tools.adb).sha256 === release.tools.adb.sha256,
        "adb changed during installation",
      );
      run(tools.adb, ["-s", serial, "wait-for-device"], {
        timeoutMs: release.validation.bootTimeoutSeconds * 1000,
      });
      const prop = (k) =>
        run(tools.adb, ["-s", serial, "shell", "getprop", k]).trim();
      waitUntil(
        () =>
          requireThat(
            prop("sys.boot_completed") === "1",
            "Android boot not complete",
          ),
        release.validation.bootTimeoutSeconds * 1000,
      );
      const active = plan
        .find((p) => p.args[0].startsWith("--set-active="))
        ?.args[0].split("=")[1];
      const postBoot = verifyPostBoot(
        release,
        (args, options) =>
          run(tools.adb, ["-s", serial, "shell", ...args], options),
        active,
        healthToken,
        requestHealth,
      );
      record({
        event: "installed-runtime-verified",
        postBoot,
        subjectSha256: sha256(canonical(release)),
      });
    } else record({ event: "installed-awaiting-boot-validation" });
  } catch (error) {
    record({ event: "failed", error: error.message });
    throw error;
  }
}

export function main(argv = process.argv.slice(2)) {
  const o = parseOptions(argv);
  const envelope = readJson(o.manifest);
  const { release, subjectSha256 } = validateEnvelope(envelope, loadPolicy());
  requireThat(
    release.target.kind === "physical",
    "use the Cuttlefish runner for virtual artifacts",
  );
  assertExecutionOptions(o);
  const metadata = verifyInstallFiles(release, o.directory);
  if (!o.confirm) {
    process.stdout.write(
      `${JSON.stringify({ subjectSha256, execution: false, startingStates: release.startingStates.map((state) => ({ id: state.id, plan: compilePlan(release, metadata.fastbootInfo, state, { wipe: state.wipeRequired, reboot: o.reboot }) })) }, null, 2)}\n`,
    );
    return;
  }
  requireThat(
    process.platform === "linux",
    "qualified execution currently requires a Linux host; other hosts are planning-only",
  );
  const healthToken = o.reboot ? readHealthToken(o.healthTokenFile) : undefined;
  const tools = toolPaths(o.toolDir, release, checkedRun),
    reader = deviceReader(tools, o.serial, pinnedToolRunner(tools, release));
  return withDeviceInstallLock(
    o.serial,
    { journal: path.resolve(o.journal), subjectSha256 },
    ({ beforeWrites }) => {
      const state = reader.inspect(release);
      requireThat(
        !o.slot || o.slot === state.targetSlot,
        "requested slot conflicts with qualified transition",
      );
      verifyFile(o.recoveryDir, state.recovery.archive);
      for (const partition of metadata.requirements.get("partition-exists")) {
        const size = reader.get(`partition-size:${partition}`);
        requireThat(
          /^0x[0-9a-fA-F]+$/.test(size) && BigInt(size) > 0n,
          "required partition missing/zero",
        );
      }
      const plan = compilePlan(release, metadata.fastbootInfo, state, o);
      const capacity = fs.statfsSync(os.tmpdir());
      const bytes = release.files.reduce((sum, f) => sum + f.sizeBytes, 0);
      requireThat(
        capacity.bavail * capacity.bsize > bytes + 1024 ** 3,
        "insufficient temporary disk capacity",
      );
      const stage = fs.mkdtempSync(path.join(os.tmpdir(), "elizaos-install-"));
      fs.chmodSync(stage, 0o700);
      let journal;
      try {
        for (const f of release.files) {
          fs.copyFileSync(
            path.join(o.directory, f.filename),
            path.join(stage, f.filename),
            fs.constants.COPYFILE_EXCL,
          );
          verifyFile(stage, f);
          fs.chmodSync(path.join(stage, f.filename), 0o400);
        }
        verifyInstallFiles(release, stage);
        journal = fs.openSync(
          o.journal,
          fs.constants.O_WRONLY |
            fs.constants.O_CREAT |
            fs.constants.O_EXCL |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        fs.writeSync(
          journal,
          `${JSON.stringify({ event: "authorized", serial: o.serial, stateId: state.id, subjectSha256, plan })}\n`,
        );
        fs.fsyncSync(journal);
        // Revalidate authorization, recovery and starting state immediately before writes.
        validateEnvelope(envelope, loadPolicy());
        verifyFile(o.recoveryDir, state.recovery.archive);
        requireThat(
          canonical(reader.inspect(release)) === canonical(state),
          "starting state changed while staging",
        );
        beforeWrites();
        executePlan({
          release,
          state,
          plan,
          reader,
          stage,
          journal,
          tools,
          serial: o.serial,
          healthToken,
        });
      } finally {
        if (journal !== undefined) fs.closeSync(journal);
        fs.rmSync(stage, { recursive: true, force: true });
      }
    },
  );
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
