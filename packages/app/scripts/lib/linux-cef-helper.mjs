/** Rebuilds the pinned CEF helper entry without a stale pre-fork stack canary. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const nativeDir = fileURLToPath(
  new URL("../../platforms/electrobun/native/linux/", import.meta.url),
);
const lockPath = path.join(nativeDir, "electrobun-cef-helper.lock.json");
const patchPath = path.join(nativeDir, "electrobun-1.18.1-cef-helper.patch");

export function hashHelperFile(file) {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let count = fs.readSync(fd, buffer, 0, buffer.length, null);
    while (count > 0) {
      hash.update(buffer.subarray(0, count));
      count = fs.readSync(fd, buffer, 0, buffer.length, null);
    }
    return hash.digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

export function requireHelperHash(file, expected) {
  const actual = hashHelperFile(file);
  if (actual !== expected) {
    throw new Error(`CEF helper input hash mismatch: ${file} (${actual}).`);
  }
}

export function validateHelperVersion(actual, expected) {
  if (actual !== expected) {
    throw new Error(
      `CEF helper requires Electrobun ${expected}, found ${actual}.`,
    );
  }
}

export function helperSdkSourcesHash(sdk) {
  const files = ["CMakeLists.txt"];
  function visit(relative) {
    for (const entry of fs.readdirSync(path.join(sdk, relative), {
      withFileTypes: true,
    })) {
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink())
        throw new Error(`Unexpected SDK link: ${child}`);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) files.push(child);
    }
  }
  for (const directory of ["include", "libcef_dll", "cmake"]) visit(directory);
  const hash = createHash("sha256");
  for (const relative of files.sort()) {
    hash.update(`${relative}\0${hashHelperFile(path.join(sdk, relative))}\n`);
  }
  return hash.digest("hex");
}

export function validateHelperCache(receipt, key, helper) {
  if (receipt.key !== key || !/^[a-f0-9]{64}$/.test(receipt.helperSha256)) {
    throw new Error(
      "CEF helper cache provenance does not match the build inputs.",
    );
  }
  requireHelperHash(helper, receipt.helperSha256);
  return receipt.helperSha256;
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { stdio: "inherit", ...options });
}

function downloadPinned(url, destination, expected) {
  if (!fs.existsSync(destination)) {
    const temporary = `${destination}.${process.pid}.download`;
    try {
      run("curl", [
        "--fail",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--output",
        temporary,
        url,
      ]);
      requireHelperHash(temporary, expected);
      fs.renameSync(temporary, destination);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  requireHelperHash(destination, expected);
}

/** Runs only while packaging Linux x64, never at app launch or general install. */
export function ensureLinuxCefHelper(packageRoot, options = {}) {
  if (
    (options.platform ?? process.platform) !== "linux" ||
    (options.arch ?? process.arch) !== "x64"
  )
    return null;
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const manifest = JSON.parse(
    fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"),
  );
  validateHelperVersion(manifest.version, lock.electrobunVersion);
  requireHelperHash(patchPath, lock.patchSha256);
  const distribution = path.join(packageRoot, "dist-linux-x64");
  const installedHelper = path.join(distribution, "process_helper");
  requireHelperHash(
    path.join(distribution, "cef", "libcef.so"),
    lock.packagedCefSha256,
  );

  const cache =
    options.cacheRoot ??
    process.env.ELIZA_DESKTOP_CEF_HELPER_CACHE ??
    path.join(
      os.homedir(),
      ".cache",
      "eliza",
      "electrobun-cef-helper",
      "1.18.1-linux-x64",
    );
  fs.mkdirSync(cache, { recursive: true });
  const compiler = run("g++", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const cmake = run("cmake", ["--version"], {
    encoding: "utf8",
    stdio: "pipe",
  });
  const key = createHash("sha256")
    .update(JSON.stringify({ lock, compiler, cmake, revision: 1 }))
    .digest("hex");
  const output = path.join(cache, `helper-${key}`);
  const receiptPath = path.join(output, "provenance.json");
  const helper = path.join(output, "process_helper");
  let receipt;
  if (fs.existsSync(receiptPath)) {
    receipt = JSON.parse(fs.readFileSync(receiptPath, "utf8"));
    validateHelperCache(receipt, key, helper);
  }
  const installedHash = hashHelperFile(installedHelper);
  if (
    installedHash !== lock.originalHelperSha256 &&
    installedHash !== receipt?.helperSha256
  ) {
    throw new Error(
      `Refusing to replace an unknown CEF helper (${installedHash}).`,
    );
  }
  if (!receipt) {
    fs.mkdirSync(output, { recursive: true });
    const archive = path.join(cache, "electrobun-helper-cef-sdk.tar.bz2");
    const sdk = path.join(cache, "electrobun-helper-sdk");
    downloadPinned(lock.sdkUrl, archive, lock.sdkSha256);
    if (!fs.existsSync(sdk)) {
      const temporary = `${sdk}.${process.pid}.extract`;
      fs.mkdirSync(temporary);
      try {
        run("tar", ["-xjf", archive, "--strip-components=1", "-C", temporary]);
        fs.renameSync(temporary, sdk);
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    if (helperSdkSourcesHash(sdk) !== lock.sdkSourcesSha256) {
      throw new Error("CEF SDK build sources do not match the pinned archive.");
    }
    requireHelperHash(
      path.join(sdk, "Release", "libcef.so"),
      lock.sdkCefSha256,
    );
    const sourceRoot = path.join(output, "source");
    const source = path.join(
      sourceRoot,
      "package/src/native/linux/cef_process_helper_linux.cpp",
    );
    fs.mkdirSync(path.dirname(source), { recursive: true });
    const original = path.join(output, "original.cpp");
    downloadPinned(lock.sourceUrl, original, lock.sourceSha256);
    fs.copyFileSync(original, source);
    run("patch", ["--batch", "--fuzz=0", "-p1", "--input", patchPath], {
      cwd: sourceRoot,
    });
    requireHelperHash(source, lock.patchedSourceSha256);
    run("cmake", [
      "-S",
      sdk,
      "-B",
      path.join(sdk, "build"),
      "-DCEF_USE_SANDBOX=OFF",
      "-DCMAKE_BUILD_TYPE=Release",
    ]);
    run("cmake", [
      "--build",
      path.join(sdk, "build"),
      "--target",
      "libcef_dll_wrapper",
      "--parallel",
      "1",
    ]);
    const object = path.join(output, "helper.o");
    run("g++", [
      "-c",
      "-std=c++20",
      "-fstack-protector-strong",
      `-I${sdk}`,
      "-o",
      object,
      source,
    ]);
    run("g++", [
      "-o",
      helper,
      object,
      path.join(sdk, "build/libcef_dll_wrapper/libcef_dll_wrapper.a"),
      path.join(sdk, "Release/libcef.so"),
      "-Wl,-rpath,$ORIGIN",
      "-lpthread",
      "-ldl",
    ]);
    receipt = {
      key,
      compiler,
      cmake,
      lock,
      helperSha256: hashHelperFile(helper),
    };
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  }
  if (installedHash !== receipt.helperSha256) {
    const temporary = `${installedHelper}.${process.pid}.source-built`;
    try {
      fs.copyFileSync(helper, temporary);
      fs.chmodSync(temporary, 0o755);
      fs.renameSync(temporary, installedHelper);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }
  fs.copyFileSync(
    receiptPath,
    path.join(distribution, "process_helper.eliza-provenance.json"),
  );
  console.log(`[desktop-build] Pinned CEF helper: ${receipt.helperSha256}`);
  return receipt.helperSha256;
}
