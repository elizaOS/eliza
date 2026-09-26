/** Shared verified platform-tools installation for setup and postinstall. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";

const execute = promisify(execFile);

export function resolvePlatformTools(config, platform) {
  const target = config?.[platform];
  if (!target || !["darwin", "linux", "win32"].includes(platform)) {
    throw new Error("Unsupported platform-tools target: " + platform);
  }
  const url = new URL(target.url);
  if (
    url.protocol !== "https:" ||
    url.hostname !== "dl.google.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/android/repository/platform-tools-") ||
    !url.pathname.endsWith(".zip") ||
    typeof target.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(target.sha256) ||
    (target.size != null &&
      (!Number.isSafeInteger(target.size) || target.size <= 0))
  ) {
    throw new Error("Invalid pinned platform-tools metadata: " + platform);
  }
  return target;
}

async function extract(archive, destination, platform) {
  const options = { timeout: 120_000, encoding: "utf8" };
  if (platform === "win32") {
    const quote = (value) => "'" + value.replaceAll("'", "''") + "'";
    await execute(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; " +
          "$zip = [System.IO.Compression.ZipFile]::OpenRead(" +
          quote(archive) +
          "); " +
          "try { foreach ($entry in $zip.Entries) { " +
          "if (!$entry.FullName.StartsWith('platform-tools/') -or $entry.FullName.Contains('\\') -or ($entry.FullName.Split('/') -contains '..') -or (($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960) { throw 'Unsafe archive entry' } " +
          "} } finally { $zip.Dispose() }; Expand-Archive -LiteralPath " +
          quote(archive) +
          " -DestinationPath " +
          quote(destination),
      ],
      options,
    );
  } else {
    const { stdout } = await execute("unzip", ["-Z1", archive], options);
    for (const name of stdout.trimEnd().split("\n")) {
      if (
        !name.startsWith("platform-tools/") ||
        name.includes("\\") ||
        name.split("/").includes("..")
      ) {
        throw new Error("Unexpected platform-tools archive entry: " + name);
      }
    }
    await execute("unzip", ["-q", archive, "-d", destination], options);
  }
}

async function validateTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await validateTree(join(directory, entry.name));
    else if (!entry.isFile())
      throw new Error("Unsupported platform-tools entry: " + entry.name);
  }
}

export async function installPinnedPlatformTools({
  vendorRoot,
  platform,
  config,
  fetchImpl = fetch,
}) {
  const target = resolvePlatformTools(config, platform);
  await mkdir(vendorRoot, { recursive: true });
  // An interrupted publication retains the interlock and recovery directory.
  const lock = join(vendorRoot, ".platform-tools-install.lock");
  await mkdir(lock);
  let stage;
  let preserveRecovery = false;
  try {
    stage = await mkdtemp(join(vendorRoot, ".platform-tools-"));
    const archive = join(stage, "archive.zip");
    const response = await fetchImpl(target.url, {
      redirect: "error",
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body)
      throw new Error(
        "Platform-tools download failed: HTTP " + response.status,
      );
    const hash = createHash("sha256");
    let bytes = 0;
    await pipeline(
      response.body,
      async function* (source) {
        for await (const chunk of source) {
          bytes += chunk.length;
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
    );
    if (
      hash.digest("hex") !== target.sha256 ||
      (target.size != null && bytes !== target.size)
    ) {
      throw new Error(
        "Platform-tools archive does not match pinned checksum or size",
      );
    }
    const unpacked = join(stage, "unpacked");
    await extract(archive, unpacked, platform);
    const tools = join(unpacked, "platform-tools");
    if (!(await lstat(tools)).isDirectory())
      throw new Error("Missing platform-tools directory");
    await validateTree(tools);
    const required =
      platform === "win32"
        ? ["adb.exe", "fastboot.exe", "AdbWinApi.dll", "AdbWinUsbApi.dll"]
        : ["adb", "fastboot"];
    for (const name of required) {
      const path = join(tools, name);
      const stat = await lstat(path);
      if (!stat.isFile() || stat.size === 0)
        throw new Error("Invalid platform-tools binary: " + name);
      if (platform !== "win32") await chmod(path, 0o755);
    }
    const destination = join(vendorRoot, "platform-tools");
    const backup = join(stage, "previous");
    let backedUp = false;
    try {
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    try {
      await rename(tools, destination);
    } catch (error) {
      if (backedUp) {
        try {
          await rename(backup, destination);
        } catch (restoreError) {
          preserveRecovery = true;
          throw new AggregateError(
            [error, restoreError],
            "Platform-tools recovery required at " + stage,
          );
        }
      }
      throw error;
    }
    return destination;
  } finally {
    if (!preserveRecovery) {
      if (stage) await rm(stage, { recursive: true, force: true });
      await rm(lock, { recursive: true });
    }
  }
}
