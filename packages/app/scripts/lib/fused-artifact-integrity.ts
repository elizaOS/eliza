/** Verifies the complete staged native library set before install or build reuse. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export function isNativeLibrary(name) {
  return /\.(?:dylib|dll|so(?:\.\d+)*)$/.test(name);
}

export function nativeLibraryInventory(directory) {
  return Object.fromEntries(
    readdirSync(directory)
      .filter(isNativeLibrary)
      .sort()
      .map((name) => [
        name,
        createHash("sha256")
          .update(readFileSync(path.join(directory, name)))
          .digest("hex"),
      ]),
  );
}

export function nativeLibraryIntegrityProblems(
  directory,
  stamp,
  { platform, arch, backend, fusedName },
) {
  const problems = [];
  if (stamp?.platform !== platform || stamp?.arch !== arch)
    problems.push("native host target changed or is unstamped");
  if (backend !== "auto" && stamp?.backend !== backend)
    problems.push("requested native backend changed");
  const expected = stamp?.libraries;
  if (
    !expected ||
    typeof expected !== "object" ||
    Array.isArray(expected) ||
    typeof expected[fusedName] !== "string" ||
    Object.entries(expected).some(
      ([name, hash]) =>
        path.basename(name) !== name ||
        !isNativeLibrary(name) ||
        typeof hash !== "string" ||
        !/^[a-f0-9]{64}$/.test(hash),
    )
  ) {
    problems.push("complete native library inventory is missing or invalid");
    return problems;
  }
  let actual;
  try {
    actual = nativeLibraryInventory(directory);
  } catch (error) {
    // error-policy:J3 unreadable artifacts are explicitly stale, never reusable.
    problems.push(`native library inventory cannot be read: ${error.message}`);
    return problems;
  }
  for (const name of new Set([
    ...Object.keys(expected),
    ...Object.keys(actual),
  ])) {
    if (actual[name] !== expected[name])
      problems.push(
        `native companion missing, changed, or unexpected: ${name}`,
      );
  }
  return problems;
}

export function nativeSourceFingerprint(forkSrc) {
  // Hash changed bytes, not porcelain filenames: a second edit to the same
  // dirty source file must invalidate the prior native build as well.
  const scopes = [
    "tools",
    "src",
    "ggml",
    "common",
    "include",
    "cmake",
    "vendor",
    "CMakeLists.txt",
  ];
  const options = { maxBuffer: 128 * 1024 * 1024 };
  const diff = execFileSync(
    "git",
    [
      "-C",
      forkSrc,
      "diff",
      "--binary",
      "--submodule=diff",
      "HEAD",
      "--",
      ...scopes,
    ],
    options,
  );
  const untracked = execFileSync(
    "git",
    [
      "-C",
      forkSrc,
      "ls-files",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...scopes,
    ],
    options,
  )
    .toString()
    .split("\0")
    .filter(Boolean)
    .sort();
  if (!diff.length && !untracked.length) return "";
  const hash = createHash("sha256").update(diff);
  for (const name of untracked)
    hash
      .update(name)
      .update("\0")
      .update(readFileSync(path.join(forkSrc, name)))
      .update("\0");
  return hash.digest("hex");
}
