#!/usr/bin/env node
/**
 * Build the Linux x64 fused-inference shared-library set in an unprivileged,
 * pinned Debian Bookworm snapshot instead of inheriting the build host's GNU
 * libc or CPU feature level.
 *
 * The expensive path is deliberately opt-in and transactional:
 *
 *   bun run linux:build-portable-fused-inference -- --out /absolute/output
 *
 * `--print-plan` and `--preflight-only` do not download or build anything.
 */

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptPath), "..");
const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export const PORTABLE_LINUX_FUSED_BUILD = Object.freeze({
  architecture: "amd64",
  backend: "vulkan",
  builderVersion: 1,
  forkCommit: "6543d9078051a9bb194c2ef5c2995f003c5158de",
  forkUrl: "https://github.com/elizaOS/llama.cpp.git",
  maxGlibc: "2.38",
  minimumOutputFreeBytes: 256 * MIB,
  minimumTempFreeBytes: 8 * GIB,
  minimumTempFreeInodes: 150_000,
  packages: Object.freeze([
    "binutils",
    "build-essential",
    "ca-certificates",
    "cmake",
    "git",
    "glslc",
    "libvulkan-dev",
    "mount",
    "nodejs",
    "spirv-headers",
  ]),
  snapshot: "20250101T000000Z",
  suite: "bookworm",
  vulkanCommit: "e3b1eec08173d6b825cd3ac88c885a63b621504a",
  vulkanIncludeSha256:
    "0753d3e3118e8f41065838c88ca785afe5bf779167b08a25dba1e891fbbea919",
  vulkanTag: "v1.4.357",
  vulkanUrl: "https://github.com/KhronosGroup/Vulkan-Headers.git",
});

const TRACKED_BUILD_FILES = Object.freeze([
  "packages/app-core/scripts/stage-desktop-fused-lib.mjs",
  "packages/app-core/scripts/build-helpers/verify-fused-symbols.mjs",
  "packages/scripts/rm-path-recursive.mjs",
]);

export const PORTABLE_RUNTIME_LIBRARIES = Object.freeze([
  "libelizainference.so",
  "libggml-base.so",
  "libggml-base.so.0",
  "libggml-cpu.so",
  "libggml-cpu.so.0",
  "libggml-vulkan.so",
  "libggml-vulkan.so.0",
  "libggml.so",
  "libggml.so.0",
  "libllama-common.so",
  "libllama-common.so.0",
  "libllama.so",
  "libllama.so.0",
  "libmtmd.so",
  "libmtmd.so.0",
]);

export const PORTABLE_SYSTEM_NEEDED_LIBRARIES = Object.freeze([
  "ld-linux-x86-64.so.2",
  "libatomic.so.1",
  "libc.so.6",
  "libdl.so.2",
  "libgcc_s.so.1",
  "libgomp.so.1",
  "libm.so.6",
  "libpthread.so.0",
  "librt.so.1",
  "libstdc++.so.6",
  "libvulkan.so.1",
]);

function log(message) {
  process.stdout.write(`[portable-linux-fused] ${message}\n`);
}

function fail(message) {
  throw new Error(`[portable-linux-fused] ${message}`);
}

export function compareNumericVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  const length = Math.max(leftParts.length, rightParts.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

export function parseGlibcVersionInfo(versionInfo) {
  const markers = [
    ...new Set(versionInfo.match(/\bGLIBC_[A-Za-z0-9_.]+\b/g) ?? []),
  ].sort();
  const unsupportedMarkers = markers.filter(
    (marker) => !/^GLIBC_\d+(?:\.\d+)+$/.test(marker),
  );
  const versions = markers
    .filter((marker) => /^GLIBC_\d+(?:\.\d+)+$/.test(marker))
    .map((marker) => marker.slice("GLIBC_".length))
    .sort(compareNumericVersions);
  return {
    maxVersion: versions.at(-1) ?? null,
    unsupportedMarkers,
    versions,
  };
}

export function parseElfDynamicSection(dynamicSection) {
  const needed = [];
  const searchPaths = [];
  for (const line of dynamicSection.split(/\r?\n/)) {
    const neededMatch = line.match(
      /\(NEEDED\).*Shared library:\s*\[([^\]]+)\]/,
    );
    if (neededMatch) needed.push(neededMatch[1]);
    const pathMatch = line.match(
      /\((?:RUNPATH|RPATH)\).*Library (?:runpath|rpath):\s*\[([^\]]*)\]/,
    );
    if (pathMatch) {
      searchPaths.push(...pathMatch[1].split(":").filter(Boolean));
    }
  }
  return {
    needed: [...new Set(needed)].sort(),
    searchPaths: [...new Set(searchPaths)].sort(),
  };
}

function isPrivateInferenceLibrary(name) {
  return /^lib(?:eliza|ggml|llama|mtmd|omnivoice)[A-Za-z0-9_.-]*\.so(?:\.\d+)*$/.test(
    name,
  );
}

export function assertRequiredRuntimeLibraries(availableNames) {
  const available = new Set(availableNames);
  const missing = PORTABLE_RUNTIME_LIBRARIES.filter(
    (library) => !available.has(library),
  );
  if (missing.length) {
    fail(
      `portable fused build omitted required output(s): ${missing.join(", ")}`,
    );
  }
}

export function assertDynamicDependencyClosure(entries, availableNames) {
  const available = new Set(availableNames);
  const permittedSystem = new Set(PORTABLE_SYSTEM_NEEDED_LIBRARIES);
  for (const entry of entries) {
    const privateDependencies = entry.needed.filter(isPrivateInferenceLibrary);
    if (
      privateDependencies.length > 0 &&
      !entry.searchPaths.some((searchPath) => searchPath === "$ORIGIN")
    ) {
      fail(
        `${entry.file} has private DT_NEEDED dependencies but no exact $ORIGIN RUNPATH/RPATH`,
      );
    }
    for (const dependency of entry.needed) {
      if (isPrivateInferenceLibrary(dependency)) {
        if (!available.has(dependency)) {
          fail(
            `${entry.file} has unresolved private DT_NEEDED dependency: ${dependency}`,
          );
        }
        continue;
      }
      if (!permittedSystem.has(dependency)) {
        fail(
          `${entry.file} has unapproved system DT_NEEDED dependency: ${dependency}`,
        );
      }
    }
  }
}

export function parseArgs(argv) {
  const options = {
    jobs: Math.max(1, Math.min(os.cpus().length || 4, 32)),
    keepTemp: false,
    out: null,
    preflightOnly: false,
    printPlan: false,
    tempRoot: os.tmpdir(),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--out") options.out = argv[++index] ?? null;
    else if (argument === "--jobs") options.jobs = Number(argv[++index]);
    else if (argument === "--temp-root") options.tempRoot = argv[++index] ?? "";
    else if (argument === "--keep-temp") options.keepTemp = true;
    else if (argument === "--preflight-only") options.preflightOnly = true;
    else if (argument === "--print-plan") options.printPlan = true;
    else if (argument === "--help" || argument === "-h") {
      options.help = true;
    } else {
      fail(`unknown argument: ${argument}`);
    }
  }
  if (
    !Number.isInteger(options.jobs) ||
    options.jobs < 1 ||
    options.jobs > 64
  ) {
    fail("--jobs must be an integer from 1 through 64");
  }
  if (!options.tempRoot) fail("--temp-root requires a path");
  return options;
}

export function buildPlan(options = {}) {
  const config = PORTABLE_LINUX_FUSED_BUILD;
  return {
    abiAudit: `all staged ELF files must require <= GLIBC_${config.maxGlibc}`,
    architecture: config.architecture,
    backend: config.backend,
    cpuNative: false,
    fork: { commit: config.forkCommit, url: config.forkUrl },
    jobs: options.jobs ?? null,
    mmdebstrap: {
      mode: "unshare",
      packages: [...config.packages],
      snapshot: config.snapshot,
      suite: config.suite,
      variant: "buildd",
    },
    output: options.out ? path.resolve(options.out) : null,
    sourceDateEpoch: 1_785_393_370,
    vulkanHeaders: {
      commit: config.vulkanCommit,
      includeSha256: config.vulkanIncludeSha256,
      tag: config.vulkanTag,
      url: config.vulkanUrl,
    },
  };
}

function commandOutput(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    maxBuffer: 64 * MIB,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) fail(`${command} could not run: ${result.error.message}`);
  if (result.status !== 0) {
    fail(
      `${command} ${args.join(" ")} exited ${result.status}\n${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

let activeChild = null;
let receivedSignal = null;

async function run(command, args, options = {}) {
  log(`$ ${command} ${args.join(" ")}`);
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });
    activeChild = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      activeChild = null;
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `[portable-linux-fused] ${command} exited ${code ?? signal}`,
          ),
        );
    });
  });
  if (receivedSignal) fail(`interrupted by ${receivedSignal}`);
}

function handleSignal(signal) {
  receivedSignal = signal;
  if (activeChild) activeChild.kill(signal);
}

function assertTool(command, args = ["--version"]) {
  const result = spawnSync(command, args, { stdio: "ignore" });
  if (result.status !== 0) {
    fail(`required host tool is unavailable: ${command}`);
  }
}

function availableCapacity(targetPath) {
  const stats = statfsSync(targetPath);
  return {
    bytes: Number(stats.bavail) * Number(stats.bsize),
    inodes: Number(stats.ffree),
  };
}

function assertCapacity(targetPath, minimumBytes, minimumInodes, label) {
  const capacity = availableCapacity(targetPath);
  if (capacity.bytes < minimumBytes) {
    fail(
      `${label} needs at least ${(minimumBytes / GIB).toFixed(1)} GiB free; ` +
        `${targetPath} has ${(capacity.bytes / GIB).toFixed(1)} GiB`,
    );
  }
  if (minimumInodes && capacity.inodes < minimumInodes) {
    fail(
      `${label} needs at least ${minimumInodes} free inodes; ` +
        `${targetPath} has ${capacity.inodes}`,
    );
  }
}

function assertCleanPinnedSuperprojectInput() {
  const config = PORTABLE_LINUX_FUSED_BUILD;
  const gitlink = commandOutput("git", [
    "-C",
    repoRoot,
    "ls-tree",
    "HEAD",
    "plugins/plugin-local-inference/native/llama.cpp",
  ]);
  if (!gitlink.includes(`commit ${config.forkCommit}\t`)) {
    fail(
      `superproject HEAD does not pin llama.cpp ${config.forkCommit}: ${gitlink}`,
    );
  }
  const changedInput = spawnSync(
    "git",
    ["-C", repoRoot, "diff", "--quiet", "HEAD", "--", ...TRACKED_BUILD_FILES],
    { stdio: "ignore" },
  );
  if (changedInput.status !== 0) {
    fail("tracked fused-build helper inputs differ from superproject HEAD");
  }
}

function validateDestination(options) {
  if (!options.out && !options.printPlan) {
    fail("--out /absolute/output is required");
  }
  if (!options.out) return null;
  if (!path.isAbsolute(options.out)) fail("--out must be an absolute path");
  const resolved = path.resolve(options.out);
  if (resolved === path.parse(resolved).root || resolved === repoRoot) {
    fail(`refusing unsafe output path: ${resolved}`);
  }
  if (existsSync(resolved)) {
    fail(`output already exists; choose a new path: ${resolved}`);
  }
  const parent = path.dirname(resolved);
  if (!existsSync(parent) || !statSync(parent).isDirectory()) {
    fail(`output parent does not exist: ${parent}`);
  }
  return resolved;
}

export function createBuilderWorkspace(tempRoot) {
  const workRoot = mkdtempSync(
    path.join(path.resolve(tempRoot), "eliza-portable-fused-"),
  );
  // mmdebstrap's unshare mode enters through a subordinate UID. mkdtemp's
  // default 0700 correctly protects ordinary temporary data but prevents that
  // mapped root from creating the rootfs. This path is freshly created above
  // and contains builder inputs only, so grant traversal without making it
  // writable by another user.
  chmodSync(workRoot, 0o755);
  const mode = statSync(workRoot).mode & 0o777;
  if (mode !== 0o755) {
    fail(
      `temporary builder workspace mode is ${mode.toString(8)}, expected 755`,
    );
  }
  return workRoot;
}

export function createPrivateOutputStage(outputParent) {
  const hostStage = mkdtempSync(
    path.join(outputParent, ".eliza-portable-fused-stage-"),
  );
  // sync-out is extracted by mmdebstrap's parent listener as the invoking
  // user, not by the subordinate UID. Keep unpublished output private.
  chmodSync(hostStage, 0o700);
  const mode = statSync(hostStage).mode & 0o777;
  if (mode !== 0o700) {
    fail(
      `transactional output stage mode is ${mode.toString(8)}, expected 700`,
    );
  }
  return hostStage;
}

function preflight(options, outputPath) {
  if (process.platform !== "linux" || process.arch !== "x64") {
    fail("this builder currently supports only Linux x64 hosts/outputs");
  }
  assertTool("git");
  assertTool("mmdebstrap");
  assertTool("readelf");
  assertTool("unshare");
  mkdirSync(options.tempRoot, { recursive: true });
  assertCapacity(
    options.tempRoot,
    PORTABLE_LINUX_FUSED_BUILD.minimumTempFreeBytes,
    PORTABLE_LINUX_FUSED_BUILD.minimumTempFreeInodes,
    "temporary builder workspace",
  );
  if (outputPath) {
    assertCapacity(
      path.dirname(outputPath),
      PORTABLE_LINUX_FUSED_BUILD.minimumOutputFreeBytes,
      0,
      "transactional output staging",
    );
  }
  const userNamespace = spawnSync(
    "unshare",
    ["--user", "--map-root-user", "true"],
    { stdio: "ignore" },
  );
  if (userNamespace.status !== 0) {
    fail("unprivileged user namespaces are unavailable; mmdebstrap cannot run");
  }
  assertCleanPinnedSuperprojectInput();
}

function copyTrackedFileAtHead(relativePath, destinationRoot) {
  const result = spawnSync(
    "git",
    ["-C", repoRoot, "show", `HEAD:${relativePath}`],
    { encoding: null, maxBuffer: 64 * MIB, stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.error || result.status !== 0) {
    fail(
      `could not read tracked build input ${relativePath}: ${result.error?.message ?? result.stderr.toString().trim()}`,
    );
  }
  const destination = path.join(destinationRoot, relativePath);
  mkdirSync(path.dirname(destination), { recursive: true });
  writeFileSync(destination, result.stdout);
  const mode = commandOutput("git", [
    "-C",
    repoRoot,
    "ls-tree",
    "HEAD",
    relativePath,
  ]).split(" ")[0];
  chmodSync(destination, mode === "100755" ? 0o755 : 0o644);
}

async function fetchPinnedCheckout({ commit, destination, tag, url }) {
  await run("git", ["init", "--quiet", destination]);
  await run("git", ["-C", destination, "remote", "add", "origin", url]);
  const fetchRef = tag ? `refs/tags/${tag}` : commit;
  await run("git", [
    "-C",
    destination,
    "fetch",
    "--depth=1",
    "--filter=blob:none",
    "origin",
    fetchRef,
  ]);
  const dereferenced = commandOutput("git", [
    "-C",
    destination,
    "rev-parse",
    "FETCH_HEAD^{commit}",
  ]);
  if (dereferenced !== commit) {
    fail(
      `${tag ? `tag ${tag}` : "fetched revision"} dereferenced to ${dereferenced}, expected ${commit}`,
    );
  }
  await run("git", [
    "-C",
    destination,
    "checkout",
    "--quiet",
    "--detach",
    commit,
  ]);
  const head = commandOutput("git", ["-C", destination, "rev-parse", "HEAD"]);
  if (head !== commit) fail(`checkout HEAD ${head} does not equal ${commit}`);
  commandOutput("git", [
    "-C",
    destination,
    "fsck",
    "--strict",
    "--no-dangling",
  ]);
  const dirty = commandOutput("git", [
    "-C",
    destination,
    "status",
    "--porcelain=v1",
    "--untracked-files=all",
  ]);
  if (dirty) fail(`pinned checkout is unexpectedly dirty:\n${dirty}`);
}

export function digestRegularTree(root) {
  const relativeFiles = [];
  const visit = (directory, prefix = "") => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute, relative);
      else if (entry.isFile()) relativeFiles.push(relative);
      else fail(`tree contains a non-regular entry: ${absolute}`);
    }
  };
  visit(root);
  relativeFiles.sort();
  const digest = createHash("sha256");
  for (const relative of relativeFiles) {
    const absolute = path.join(root, relative);
    const content = readFileSync(absolute);
    const mode = (statSync(absolute).mode & 0o777).toString(8);
    digest.update(relative);
    digest.update("\0");
    digest.update(mode);
    digest.update("\0");
    digest.update(String(content.length));
    digest.update("\0");
    digest.update(content);
  }
  return { fileCount: relativeFiles.length, sha256: digest.digest("hex") };
}

async function prepareInputs(workRoot) {
  const config = PORTABLE_LINUX_FUSED_BUILD;
  const sourceBundle = path.join(workRoot, "source");
  mkdirSync(sourceBundle, { recursive: true });
  for (const relativePath of TRACKED_BUILD_FILES) {
    copyTrackedFileAtHead(relativePath, sourceBundle);
  }

  const forkDestination = path.join(
    sourceBundle,
    "plugins/plugin-local-inference/native/llama.cpp",
  );
  mkdirSync(path.dirname(forkDestination), { recursive: true });
  await fetchPinnedCheckout({
    commit: config.forkCommit,
    destination: forkDestination,
    url: config.forkUrl,
  });

  const vulkanDestination = path.join(workRoot, "Vulkan-Headers");
  await fetchPinnedCheckout({
    commit: config.vulkanCommit,
    destination: vulkanDestination,
    tag: config.vulkanTag,
    url: config.vulkanUrl,
  });
  const includeDigest = digestRegularTree(
    path.join(vulkanDestination, "include"),
  );
  if (includeDigest.sha256 !== config.vulkanIncludeSha256) {
    fail(
      `Vulkan include tree SHA-256 ${includeDigest.sha256} does not match ${config.vulkanIncludeSha256}`,
    );
  }
  return { includeDigest, sourceBundle, vulkanDestination };
}

function shellWord(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

export function mmdebstrapArguments({
  hostStage,
  jobs,
  rootfs,
  sourceBundle,
  vulkanDestination,
}) {
  const config = PORTABLE_LINUX_FUSED_BUILD;
  const mirror = `deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/${config.snapshot} ${config.suite} main`;
  const buildCommand =
    "cd /work && " +
    "env SOURCE_DATE_EPOCH=1785393370 TZ=UTC LC_ALL=C " +
    "node packages/app-core/scripts/stage-desktop-fused-lib.mjs " +
    `--variant vulkan --portable-cpu --jobs ${jobs} --out /out --force`;
  const configureChrootGitTrust =
    "git config --system --add safe.directory " +
    "/work/plugins/plugin-local-inference/native/llama.cpp";
  const dpkgQueryFormat = "$" + "{binary:Package}\\t" + "$" + "{Version}\\n";
  const packageManifestCommand =
    `dpkg-query -W -f='${dpkgQueryFormat}' ` +
    `${config.packages.join(" ")} > /out/.builder-packages.tsv && ` +
    "ldd --version | head -n 1 > /out/.builder-glibc.txt";
  return [
    "--mode=unshare",
    "--format=directory",
    "--variant=buildd",
    `--architectures=${config.architecture}`,
    `--include=${config.packages.join(",")}`,
    '--aptopt=Acquire::Check-Valid-Until "false"',
    '--aptopt=Acquire::Languages "none"',
    '--aptopt=Acquire::Retries "3"',
    "--chrooted-customize-hook=mkdir -p /work /out",
    `--customize-hook=sync-in ${shellWord(sourceBundle)} /work`,
    `--customize-hook=sync-in ${shellWord(path.join(vulkanDestination, "include"))} /usr/include`,
    `--chrooted-customize-hook=${configureChrootGitTrust}`,
    `--chrooted-customize-hook=${buildCommand}`,
    `--chrooted-customize-hook=${packageManifestCommand}`,
    `--customize-hook=sync-out /out ${shellWord(hostStage)}`,
    config.suite,
    rootfs,
    mirror,
  ];
}

function isElf(filePath) {
  const content = readFileSync(filePath);
  return (
    content.length >= 4 &&
    content[0] === 0x7f &&
    content[1] === 0x45 &&
    content[2] === 0x4c &&
    content[3] === 0x46
  );
}

function walkRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stats = lstatSync(absolute);
      if (stats.isSymbolicLink())
        fail(`staged output contains symlink: ${absolute}`);
      if (stats.isDirectory()) visit(absolute);
      else if (stats.isFile()) files.push(absolute);
      else fail(`staged output contains unsupported entry: ${absolute}`);
    }
  };
  visit(root);
  return files.sort();
}

function sha256File(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

export function auditPortableOutput(hostStage) {
  const config = PORTABLE_LINUX_FUSED_BUILD;
  const stagedFiles = walkRegularFiles(hostStage);
  // `$ORIGIN` is the output root, so only direct sibling files can satisfy a
  // private DT_NEEDED entry. A same-named file nested below it is not closure.
  const stagedNames = readdirSync(hostStage, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  assertRequiredRuntimeLibraries(stagedNames);
  for (const required of PORTABLE_RUNTIME_LIBRARIES) {
    if (!isElf(path.join(hostStage, required))) {
      fail(`required portable runtime library is not ELF: ${required}`);
    }
  }
  const buildStampPath = path.join(hostStage, ".eliza-fused-build-stamp.json");
  if (!existsSync(buildStampPath)) fail("fused build stamp is missing");
  const buildStamp = JSON.parse(readFileSync(buildStampPath, "utf8"));
  if (
    buildStamp.forkCommit !== config.forkCommit ||
    buildStamp.forkDirty !== "" ||
    buildStamp.backend !== "vulkan" ||
    buildStamp.cpuNative !== false
  ) {
    fail(
      `fused build stamp contradicts pinned portable inputs: ${JSON.stringify(buildStamp)}`,
    );
  }
  const fusedSha256 = sha256File(path.join(hostStage, "libelizainference.so"));
  if (buildStamp.fusedSha256 !== fusedSha256) {
    fail("fused library SHA-256 does not match its build stamp");
  }

  const abi = [];
  const dynamicDependencies = [];
  let maxObservedGlibc = null;
  for (const filePath of stagedFiles) {
    if (!isElf(filePath)) continue;
    const header = commandOutput("readelf", ["-W", "-h", filePath]);
    if (!/Machine:\s+Advanced Micro Devices X86-64/.test(header)) {
      fail(`staged ELF is not x86-64: ${filePath}`);
    }
    const parsed = parseGlibcVersionInfo(
      commandOutput("readelf", ["-W", "--version-info", filePath]),
    );
    if (parsed.unsupportedMarkers.length) {
      fail(
        `${path.basename(filePath)} uses unsupported GNU libc markers: ${parsed.unsupportedMarkers.join(", ")}`,
      );
    }
    if (
      parsed.maxVersion &&
      compareNumericVersions(parsed.maxVersion, config.maxGlibc) > 0
    ) {
      fail(
        `${path.basename(filePath)} requires GLIBC_${parsed.maxVersion}, above GLIBC_${config.maxGlibc}`,
      );
    }
    if (
      parsed.maxVersion &&
      (!maxObservedGlibc ||
        compareNumericVersions(parsed.maxVersion, maxObservedGlibc) > 0)
    ) {
      maxObservedGlibc = parsed.maxVersion;
    }
    const dynamic = parseElfDynamicSection(
      commandOutput("readelf", ["-W", "-d", filePath]),
    );
    dynamicDependencies.push({
      file: path.relative(hostStage, filePath),
      ...dynamic,
    });
    abi.push({
      file: path.relative(hostStage, filePath),
      maxGlibc: parsed.maxVersion,
      needed: dynamic.needed,
      searchPaths: dynamic.searchPaths,
      versions: parsed.versions,
    });
  }
  if (abi.length === 0) fail("portable fused build produced no ELF files");
  assertDynamicDependencyClosure(dynamicDependencies, stagedNames);
  return {
    abi,
    buildStamp,
    dynamicDependencies,
    fusedSha256,
    maxObservedGlibc,
  };
}

function finalizeProvenance({ audit, hostStage, includeDigest, jobs }) {
  const packageManifestPath = path.join(hostStage, ".builder-packages.tsv");
  const glibcManifestPath = path.join(hostStage, ".builder-glibc.txt");
  const packages = readFileSync(packageManifestPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const builderGlibc = readFileSync(glibcManifestPath, "utf8").trim();
  rmSync(packageManifestPath);
  rmSync(glibcManifestPath);

  const files = walkRegularFiles(hostStage).map((filePath) => ({
    bytes: statSync(filePath).size,
    file: path.relative(hostStage, filePath),
    mode: (statSync(filePath).mode & 0o777).toString(8).padStart(3, "0"),
    sha256: sha256File(filePath),
  }));
  const provenance = {
    schemaVersion: 1,
    builder: "scripts/portable-linux-fused-inference.mjs",
    generatedAt: new Date().toISOString(),
    environment: {
      architecture: PORTABLE_LINUX_FUSED_BUILD.architecture,
      builderGlibc,
      mmdebstrapMode: "unshare",
      packages,
      snapshot: PORTABLE_LINUX_FUSED_BUILD.snapshot,
      suite: PORTABLE_LINUX_FUSED_BUILD.suite,
      variant: "buildd",
    },
    inputs: {
      fork: {
        commit: PORTABLE_LINUX_FUSED_BUILD.forkCommit,
        url: PORTABLE_LINUX_FUSED_BUILD.forkUrl,
      },
      sourceDateEpoch: 1_785_393_370,
      vulkanHeaders: {
        commit: PORTABLE_LINUX_FUSED_BUILD.vulkanCommit,
        includeFileCount: includeDigest.fileCount,
        includeSha256: includeDigest.sha256,
        tag: PORTABLE_LINUX_FUSED_BUILD.vulkanTag,
        url: PORTABLE_LINUX_FUSED_BUILD.vulkanUrl,
      },
    },
    build: { backend: "vulkan", cpuNative: false, jobs },
    abi: {
      files: audit.abi,
      maxAllowedGlibc: PORTABLE_LINUX_FUSED_BUILD.maxGlibc,
      maxObservedGlibc: audit.maxObservedGlibc,
    },
    outputs: files,
  };
  writeFileSync(
    path.join(hostStage, "PORTABLE_FUSED_PROVENANCE.json"),
    `${JSON.stringify(provenance, null, 2)}\n`,
  );
  return provenance;
}

function safeRemoveBuilderWorkspace(workRoot, keepTemp) {
  if (!workRoot || !existsSync(workRoot) || keepTemp) return;
  const base = path.basename(workRoot);
  if (!base.startsWith("eliza-portable-fused-")) {
    fail(`refusing to clean unrecognized builder workspace: ${workRoot}`);
  }
  const result = spawnSync(
    "unshare",
    [
      "--user",
      "--map-auto",
      "--map-root-user",
      "--mount",
      "--fork",
      "--",
      "rm",
      "-rf",
      "--",
      workRoot,
    ],
    { stdio: "inherit" },
  );
  if (result.status !== 0) {
    log(`WARNING: could not clean temporary workspace: ${workRoot}`);
  }
}

function printHelp() {
  process.stdout.write(
    `Usage:\n  bun run linux:build-portable-fused-inference -- --out /absolute/output [options]\n\nOptions:\n  --out PATH         New output directory (required; must not exist)\n  --jobs N           Build parallelism, 1-64 (default: host CPUs, capped at 32)\n  --temp-root PATH   Builder workspace parent (default: system temporary dir)\n  --keep-temp        Retain the builder workspace for diagnosis\n  --preflight-only   Verify tools, capacity, namespace, and repository pins only\n  --print-plan       Print the immutable build plan as JSON; do no work\n`,
  );
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }
  if (options.printPlan) {
    process.stdout.write(`${JSON.stringify(buildPlan(options), null, 2)}\n`);
    return;
  }
  const outputPath = validateDestination(options);
  preflight(options, outputPath);
  if (options.preflightOnly) {
    log("preflight OK; no download or build was run");
    return;
  }

  const workRoot = createBuilderWorkspace(options.tempRoot);
  let hostStage = null;
  log(`temporary workspace: ${workRoot}`);
  try {
    hostStage = createPrivateOutputStage(path.dirname(outputPath));
    const inputs = await prepareInputs(workRoot);
    const rootfs = path.join(workRoot, "rootfs");
    await run(
      "mmdebstrap",
      mmdebstrapArguments({
        hostStage,
        jobs: options.jobs,
        rootfs,
        sourceBundle: inputs.sourceBundle,
        vulkanDestination: inputs.vulkanDestination,
      }),
    );
    const audit = auditPortableOutput(hostStage);
    const provenance = finalizeProvenance({
      audit,
      hostStage,
      includeDigest: inputs.includeDigest,
      jobs: options.jobs,
    });
    renameSync(hostStage, outputPath);
    hostStage = null;
    log(`published transactional output: ${outputPath}`);
    log(
      `ABI audit OK: ${provenance.abi.files.length} ELF files, highest GLIBC_${provenance.abi.maxObservedGlibc}`,
    );
  } finally {
    if (hostStage && existsSync(hostStage))
      rmSync(hostStage, { recursive: true });
    if (options.keepTemp) log(`retained temporary workspace: ${workRoot}`);
    else safeRemoveBuilderWorkspace(workRoot, false);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => handleSignal(signal));
  }
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
