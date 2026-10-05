/** Shared flash metadata validation for image builders and packaged installers. */
import path from "node:path";

export const REQUIRED_GRIZZLY_ARTIFACTS = Object.freeze([
  "boot.img",
  "init_boot.img",
  "dtbo.img",
  "vendor_kernel_boot.img",
  "pvmfw.img",
  "vendor_boot.img",
  "vbmeta.img",
  "system.img",
  "system_dlkm.img",
  "system_ext.img",
  "product.img",
  "vendor.img",
  "vendor_dlkm.img",
  "system_other.img",
  "super_empty.img",
  "android-info.txt",
  "fastboot-info.txt",
]);

const DYNAMIC_PARTITIONS = Object.freeze([
  "system",
  "system_dlkm",
  "system_ext",
  "product",
  "vendor",
  "vendor_dlkm",
  "system_other",
]);

function fail(message) {
  throw new Error(`[grizzly-bundle] ${message}`);
}

function assertImageFilename(filename, command) {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._+-]*\.img$/.test(filename) ||
    path.basename(filename) !== filename
  ) {
    fail(`unsafe image filename ${JSON.stringify(filename)} in ${command}`);
  }
  return filename;
}

export function parseFastbootInfoArtifacts(contents) {
  const artifacts = new Set();
  const commands = [];
  let version = null;
  for (const rawLine of contents.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const tokens = line.split(/\s+/);
    const command = tokens.shift();
    commands.push({ command, line, tokens: [...tokens] });
    if (command === "version") {
      if (tokens.length !== 1 || tokens[0] !== "1" || version !== null) {
        fail(
          `fastboot-info must contain exactly one supported version 1 line: ${line}`,
        );
      }
      version = 1;
      continue;
    }
    if (command === "flash") {
      const flags = tokens.filter((token) => token.startsWith("--"));
      if (new Set(flags).size !== flags.length) {
        fail(`duplicate fastboot flash flag in ${line}`);
      }
      const positional = tokens.filter((token) => {
        if (token === "--apply-vbmeta" || token === "--slot-other")
          return false;
        if (token.startsWith("--")) {
          fail(`unsupported fastboot flash flag ${token} in ${line}`);
        }
        return true;
      });
      if (positional.length < 1 || positional.length > 2) {
        fail(`invalid fastboot flash command: ${line}`);
      }
      const [partition, explicitFilename] = positional;
      if (!/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(partition)) {
        fail(`unsafe partition ${JSON.stringify(partition)} in ${line}`);
      }
      const filename = assertImageFilename(
        explicitFilename ?? `${partition}.img`,
        line,
      );
      artifacts.add(filename);
      Object.assign(commands.at(-1), { partition, filename, flags });
      continue;
    }
    if (command === "update-super") {
      if (tokens.length !== 0) fail(`invalid update-super command: ${line}`);
      artifacts.add("super_empty.img");
      continue;
    }
    if (command === "reboot") {
      if (
        tokens.length > 1 ||
        (tokens.length === 1 && tokens[0] !== "fastboot")
      ) {
        fail(`invalid reboot command: ${line}`);
      }
      continue;
    }
    if (command === "if-wipe") {
      if (
        tokens.length !== 2 ||
        tokens[0] !== "erase" ||
        !["cache", "userdata", "metadata"].includes(tokens[1])
      ) {
        fail(`invalid if-wipe command: ${line}`);
      }
      continue;
    }
    if (command === "erase") {
      if (
        tokens.length !== 1 ||
        !/^[A-Za-z0-9][A-Za-z0-9._+-]*$/.test(tokens[0])
      ) {
        fail(`invalid erase command: ${line}`);
      }
      continue;
    }
    fail(`unsupported fastboot-info command: ${line}`);
  }
  if (version === null) fail("fastboot-info is missing its version");
  if (commands[0]?.command !== "version") {
    fail("fastboot-info version must be its first command");
  }
  return { artifacts: [...artifacts], commands };
}

export function assertSafeFlashMetadata({ androidInfo, fastbootInfo }) {
  const boardRequirements = androidInfo
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("require board="));
  if (
    boardRequirements.length !== 1 ||
    boardRequirements[0] !== "require board=grizzly"
  ) {
    fail(
      "android-info.txt must contain exactly one require board=grizzly constraint",
    );
  }
  const { artifacts, commands } = parseFastbootInfoArtifacts(fastbootInfo);
  for (const filename of REQUIRED_GRIZZLY_ARTIFACTS.filter((entry) =>
    entry.endsWith(".img"),
  )) {
    if (!artifacts.includes(filename)) {
      fail(
        `fastboot-info does not reference required flash artifact ${filename}`,
      );
    }
  }
  const rebootFastbootIndexes = commands.flatMap(
    ({ command, tokens }, index) =>
      command === "reboot" && tokens.length === 1 && tokens[0] === "fastboot"
        ? [index]
        : [],
  );
  const updateSuperIndexes = commands.flatMap(({ command }, index) =>
    command === "update-super" ? [index] : [],
  );
  const terminalRebootIndexes = commands.flatMap(
    ({ command, tokens }, index) =>
      command === "reboot" && tokens.length === 0 ? [index] : [],
  );
  if (rebootFastbootIndexes.length !== 1 || updateSuperIndexes.length !== 1) {
    fail("fastboot-info must contain one reboot fastboot and one update-super");
  }
  // The pinned fastboot flashall/update implementation adds its final reboot
  // after the file's tasks. Generated plans may therefore omit this command.
  // An explicit reboot must still be unique and last: an early reboot would
  // interrupt the coherent flash before all partitions are installed.
  if (
    terminalRebootIndexes.length > 1 ||
    (terminalRebootIndexes.length === 1 &&
      terminalRebootIndexes[0] !== commands.length - 1)
  ) {
    fail("fastboot-info may contain at most one terminal reboot, at the end");
  }
  const rebootFastbootIndex = rebootFastbootIndexes[0];
  const updateSuperIndex = updateSuperIndexes[0];
  if (rebootFastbootIndex >= updateSuperIndex) {
    fail("reboot fastboot must precede update-super");
  }
  const flashedDynamicPartitions = new Set();
  const flashedPartitions = new Set();
  const conditionalErases = new Set();
  const lastFlashIndex = commands.findLastIndex(
    (entry) => entry.command === "flash",
  );
  for (const [index, commandEntry] of commands.entries()) {
    const { command } = commandEntry;
    if (command === "erase") {
      fail("fastboot-info must not erase any partition unconditionally");
    }
    if (command === "if-wipe") {
      const partition = commandEntry.tokens[1];
      if (
        !["userdata", "metadata"].includes(partition) ||
        conditionalErases.has(partition) ||
        index <= lastFlashIndex
      ) {
        fail(
          "conditional erase must be unique, limited to userdata/metadata and follow all image writes",
        );
      }
      conditionalErases.add(partition);
    }
    if (command !== "flash") continue;
    const { partition, filename, flags } = commandEntry;
    let logicalPartition = partition;
    if (flags.includes("--slot-other")) {
      if (partition !== "system" || filename !== "system_other.img") {
        fail(
          `fastboot-info contains an unsupported --slot-other flash: ${commandEntry.line}`,
        );
      }
      logicalPartition = "system_other";
    }
    if (
      filename !== `${logicalPartition}.img` ||
      (flags.includes("--apply-vbmeta") && logicalPartition !== "vbmeta") ||
      (logicalPartition === "vbmeta" && !flags.includes("--apply-vbmeta"))
    ) {
      fail(
        `fastboot-info contains an unsafe flash mapping: ${commandEntry.line}`,
      );
    }
    if (flashedPartitions.has(logicalPartition)) {
      fail(
        `fastboot-info flashes partition ${logicalPartition} more than once`,
      );
    }
    flashedPartitions.add(logicalPartition);
    const isBootChainPartition =
      [
        "boot",
        "init_boot",
        "dtbo",
        "vendor_kernel_boot",
        "pvmfw",
        "vendor_boot",
      ].includes(logicalPartition) ||
      /^vbmeta(?:_[A-Za-z0-9._+-]+)?$/.test(logicalPartition);
    if (
      !isBootChainPartition &&
      !DYNAMIC_PARTITIONS.includes(logicalPartition)
    ) {
      fail(`fastboot-info flashes unsupported partition ${logicalPartition}`);
    }
    if (isBootChainPartition && index >= rebootFastbootIndex) {
      fail(
        `fastboot-info flashes boot-chain partition ${logicalPartition} after entering fastbootd`,
      );
    }
    if (DYNAMIC_PARTITIONS.includes(logicalPartition)) {
      if (index < updateSuperIndex) {
        fail(
          `fastboot-info attempts to flash ${logicalPartition} before update-super`,
        );
      }
      flashedDynamicPartitions.add(logicalPartition);
    }
  }
  for (const partition of DYNAMIC_PARTITIONS) {
    if (!flashedDynamicPartitions.has(partition)) {
      fail(
        `fastboot-info does not flash required dynamic partition ${partition}`,
      );
    }
  }
  return {
    artifacts,
    rebootFastbootIndex,
    updateSuperIndex,
    terminalRebootAuthority:
      terminalRebootIndexes.length === 1 ? "fastboot-info" : "fastboot-cli",
  };
}
