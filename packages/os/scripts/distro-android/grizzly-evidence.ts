#!/usr/bin/env node
/**
 * grizzly-evidence.ts — capture boot evidence from a Pixel 11 Pro in any state.
 *
 * A device stuck on the G logo may have no adb. Possible evidence surfaces are
 * bootloader getvar/OEM diagnostics, pstore, and — once a shell exists —
 * logcat, dmesg, init and graphics service states. Firmware support, privileges
 * and retention across resets vary; empty pstore is not proof init never ran.
 * This script captures responding surfaces into one dated directory so every flash
 * attempt leaves an attributable record (active slot included, because the
 * bootloader silently falls back to the other slot after repeated failures).
 *
 * Usage:
 *   node scripts/distro-android/grizzly-evidence.ts [--device SERIAL] [--out DIR]
 *
 * Every command's stdout/stderr is written verbatim, including failures —
 * "this surface did not respond" is itself evidence and is never fabricated.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../..");

function parseArgs(argv) {
  const options = { device: "", outRoot: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    const value = argv[index + 1];
    if (argument === "--device" && value) {
      options.device = value;
      index += 1;
    } else if (argument === "--out" && value) {
      options.outRoot = path.resolve(value);
      index += 1;
    } else {
      throw new Error(`[grizzly-evidence] unknown argument: ${argument}`);
    }
  }
  return options;
}

export function capture(
  outDir,
  name,
  command,
  args,
  { timeoutMs = 30_000 } = {},
) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  const status = result.error?.message ?? `exit ${result.status ?? "signal"}`;
  const body = [
    `# ${command} ${args.join(" ")}`,
    `# status: ${status}`,
    "",
    "## stdout",
    result.stdout ?? "",
    "## stderr",
    result.stderr ?? "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, `${name}.txt`), body);
  const succeeded = !result.error && result.status === 0;
  console.log(
    `[grizzly-evidence] ${succeeded ? "ok  " : "fail"} ${name} (${status})`,
  );
  return {
    succeeded,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

export function selectEvidenceTransports({
  device = "",
  adbOutput = "",
  fastbootOutput = "",
} = {}) {
  const rows = (output, states) =>
    output.split(/\r?\n/).flatMap((line) => {
      const [serial, state] = line.trim().split(/\s+/);
      return serial && states.includes(state) ? [{ serial, state }] : [];
    });
  const adb = rows(adbOutput, [
    "device",
    "recovery",
    "sideload",
    "offline",
    "unauthorized",
  ]);
  // platform-tools labels early DBL devices "ROM Recovery", not "fastboot".
  const fastboot = fastbootOutput.split(/\r?\n/).flatMap((line) => {
    const match = line.trim().match(/^(\S+)\s+(fastboot|ROM Recovery)$/);
    return match ? [{ serial: match[1], state: match[2] }] : [];
  });
  const serials = [...new Set([...adb, ...fastboot].map((row) => row.serial))];
  if (!device && serials.length > 1) {
    throw new Error(
      "[grizzly-evidence] multiple devices detected; specify --device SERIAL",
    );
  }
  const selected = device || serials[0] || null;
  return {
    device: selected,
    adb: adb.some(
      (row) =>
        row.serial === selected && ["device", "recovery"].includes(row.state),
    ),
    fastboot: fastboot.some((row) => row.serial === selected),
  };
}

export function captureEvidence(
  { device = "", outRoot = "" } = {},
  captureCommand = capture,
) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outDir = path.resolve(
    outRoot || path.join(repoRoot, "reports", "grizzly-evidence"),
    stamp,
  );
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  console.log(`[grizzly-evidence] writing to ${outDir}`);

  // Bootloader surface: slot state, unlock state, firmware versions.
  const fastbootDevices = captureCommand(
    outDir,
    "fastboot-devices",
    "fastboot",
    ["devices"],
  );
  const adbDevices = captureCommand(outDir, "adb-devices", "adb", [
    "devices",
    "-l",
  ]);
  const selected = selectEvidenceTransports({
    device,
    adbOutput: adbDevices.succeeded ? adbDevices.stdout : "",
    fastbootOutput: fastbootDevices.succeeded ? fastbootDevices.stdout : "",
  });
  fs.writeFileSync(
    path.join(outDir, "device-selection.json"),
    `${JSON.stringify(selected, null, 2)}\n`,
  );
  const targetArgs = (rest) => ["-s", selected.device, ...rest];
  // Inventory is not model identification. Only issue device-specific OEM
  // diagnostics after a successful, unambiguous grizzly product query.
  if (selected.fastboot) {
    const product = captureCommand(
      outDir,
      "fastboot-product",
      "fastboot",
      targetArgs(["getvar", "product"]),
    );
    const output = `${product.stdout ?? ""}\n${product.stderr ?? ""}`;
    const products = output
      .split(/\r?\n/)
      .map((line) => line.replace(/^\(bootloader\)\s*/, ""))
      .filter((line) => line.startsWith("product:"))
      .map((line) => line.slice(8).trim());
    selected.fastboot =
      product.succeeded && products.length === 1 && products[0] === "grizzly";
  }
  if (selected.adb) {
    const product = captureCommand(
      outDir,
      "adb-product",
      "adb",
      targetArgs(["shell", "getprop", "ro.product.device"]),
    );
    selected.adb = product.succeeded && product.stdout.trim() === "grizzly";
  }
  fs.writeFileSync(
    path.join(outDir, "device-identity.json"),
    `${JSON.stringify({ device: selected.device, grizzlyAdb: selected.adb, grizzlyFastboot: selected.fastboot }, null, 2)}\n`,
  );
  if (selected.fastboot) {
    captureCommand(
      outDir,
      "fastboot-getvar-all",
      "fastboot",
      targetArgs(["getvar", "all"]),
    );
    // Tensor abl exposes read-only OEM debug commands; enumerate what this
    // bootloader offers. Some firmware can expose a previous kernel console;
    // do not assume a forced reset preserves it or that all OEM commands exist.
    // Unsupported commands just record their failure; that too is evidence.
    const oemCaptures = [
      ["fastboot-oem-cmds", ["oem", "list-oem-cmds"]],
      ["fastboot-oem-last-dmesg", ["oem", "last_dmesg"]],
      ["fastboot-oem-dmesg", ["oem", "dmesg"]],
      ["fastboot-oem-uart-status", ["oem", "uart", "status"]],
    ];
    for (const [name, rest] of oemCaptures) {
      captureCommand(outDir, name, "fastboot", targetArgs(rest));
    }
  }

  // Sideload, unauthorized and offline transports do not provide a shell.
  if (!selected.adb) {
    console.log(
      "[grizzly-evidence] selected device has no adb shell surface; available inventory/bootloader evidence retained. " +
        "Recovery may expose pstore, but rebooting can discard logs; this tool does not reboot the device.",
    );
    return outDir;
  }

  const shellCaptures = [
    ["adb-state", ["get-state"]],
    // Stock reports ro.product.build.16k_page.enabled=false (4 KiB pages);
    // capture the kernel's actual page size whenever a shell answers so a
    // future QPR 16 KiB migration cannot silently invalidate that premise.
    ["page-size", ["shell", "getconf", "PAGE_SIZE"]],
    ["getprop", ["shell", "getprop"]],
    // Read-only MTE diagnostics. Advertised CPU features do not establish
    // functional MTE or acceptable performance. Never toggle OEM MTE here.
    ["kernel-cmdline", ["shell", "cat", "/proc/cmdline"]],
    ["kernel-bootconfig", ["shell", "cat", "/proc/bootconfig"]],
    ["cpuinfo", ["shell", "cat", "/proc/cpuinfo"]],
    [
      "super-size",
      ["shell", "blockdev", "--getsize64", "/dev/block/by-name/super"],
    ],
    ["logical-partitions", ["shell", "lpdump", "--json"]],
    ["apex-list", ["shell", "ls", "-l", "/apex"]],
    ["service-list", ["shell", "service", "list"]],
    ["dmesg", ["shell", "dmesg"]],
    ["logcat", ["shell", "logcat", "-b", "all", "-d"]],
    ["pstore-list", ["shell", "ls", "-l", "/sys/fs/pstore/"]],
    // These may contain prior-boot markers if the kernel/firmware retained them.
    [
      "pstore-console-ramoops",
      ["shell", "cat", "/sys/fs/pstore/console-ramoops*"],
    ],
    ["pstore-pmsg-ramoops", ["shell", "cat", "/sys/fs/pstore/pmsg-ramoops*"]],
    [
      "init-svc-graphics",
      [
        "shell",
        "getprop | grep -E 'init\\.svc\\.(surfaceflinger|zygote|vendor|bootanim)|vendor\\.elizaos|sys\\.boot_completed|ro\\.boot\\.slot'",
      ],
    ],
    [
      "service-list-graphics",
      [
        "shell",
        "service list | grep -iE 'surface|composer|allocator|mapper' || true",
      ],
    ],
    ["modules", ["shell", "cat", "/proc/modules"]],
    ["dev-dri", ["shell", "ls", "-l", "/dev/dri"]],
    [
      "vendor-egl",
      ["shell", "ls", "-l", "/vendor/lib64/egl", "/vendor/lib64/hw"],
    ],
    ["tombstones", ["shell", "ls", "-l", "/data/tombstones"]],
    ["persisted-logd", ["shell", "ls", "-l", "/data/misc/logd"]],
    ["recovery-log", ["shell", "cat", "/tmp/recovery.log"]],
    ["mounts", ["shell", "cat", "/proc/mounts"]],
    ["metadata-markers", ["shell", "ls", "-l", "/metadata/"]],
  ];
  for (const [name, rest] of shellCaptures) {
    captureCommand(outDir, name, "adb", targetArgs(rest));
  }
  return outDir;
}

if (import.meta.main) {
  captureEvidence(parseArgs(process.argv.slice(2)));
}
