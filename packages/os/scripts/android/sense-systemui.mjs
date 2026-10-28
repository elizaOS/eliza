// Exact manifest-listed patch admission, not verification of a complete AOSP tree or image.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const bundleDirectory = (bundle) => {
  if (!["ops", "chip"].includes(bundle)) throw Error("Unknown SystemUI bundle");
  return path.join(
    root,
    "android/sense/systemui",
    bundle === "chip" ? "chip" : "",
  );
};
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
function regular(file) {
  if (
    !fs.lstatSync(file).isFile() ||
    fs.realpathSync(file) !== path.resolve(file)
  )
    throw Error(`Not a regular, non-symlink path: ${file}`);
  return fs.readFileSync(file);
}
export function verifyListenerSystemui(
  source,
  state = "before",
  bundle = "chip",
) {
  const directory = bundleDirectory(bundle);
  if (!["before", "after"].includes(state))
    throw Error("Expected before or after state");
  const manifestBytes = regular(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes);
  const patch = regular(path.join(directory, manifest.patch));
  if (sha(patch) !== manifest.patchSha256)
    throw Error("SystemUI patch hash mismatch");
  if (
    sha(regular(path.join(root, "android/sources/pixel10a-stallion.json"))) !==
    manifest.baselineLockSha256
  )
    throw Error("Baseline source lock changed; re-review SystemUI patch");
  const project = path.join(fs.realpathSync(source), manifest.project);
  const files = manifest.files.map((entry) => {
    const file = path.join(project, entry.path);
    let digest;
    if (state === "before" && entry.beforeSha256 === null) {
      try {
        fs.lstatSync(file);
        throw Error(`New SystemUI path already exists: ${entry.path}`);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      digest = null;
    } else digest = sha(regular(file));
    if (digest !== entry[`${state}Sha256`])
      throw Error(`SystemUI ${state} image mismatch: ${entry.path}`);
    return { path: entry.path, sha256: digest };
  });
  return {
    schema: 1,
    scope: `${files.length} manifest-listed SystemUI files only; remaining source tree is not verified`,
    bundle,
    state,
    expectedProjectRevision: manifest.revision,
    baselineLockSha256: manifest.baselineLockSha256,
    manifestSha256: sha(manifestBytes),
    patchSha256: manifest.patchSha256,
    files,
    fullTreeVerified: false,
    imageBuilt: false,
    lockAodIndicatorQualified: false,
    // Source-level only: the lease is never compiled, booted or qualified by this receipt.
    indicatorHealthLeaseImplemented:
      bundle === "chip" && manifest.indicatorHealthLeaseImplemented === true,
    indicatorHealthLeaseQualified: false,
    systemUiCompiled: false,
  };
}

// Prepare a tiny overlay for a disposable build copy; never write into the supplied AOSP source.
export function prepareListenerSystemui(source, output, bundle = "chip") {
  const directory = bundleDirectory(bundle);
  const manifest = JSON.parse(regular(path.join(directory, "manifest.json")));
  source = fs.realpathSync(source);
  output = path.resolve(output);
  const parent = fs.realpathSync(path.dirname(output));
  if (parent === source || parent.startsWith(source + path.sep))
    throw Error("Output must be outside the supplied AOSP source");
  const before = verifyListenerSystemui(source, "before", bundle);
  if (fs.existsSync(output)) throw Error("Output must not exist");
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "sense-systemui-"));
  try {
    for (const entry of before.files) {
      const file = path.join(temporary, "frameworks/base", entry.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (entry.sha256 !== null)
        fs.copyFileSync(path.join(source, "frameworks/base", entry.path), file);
    }
    execFileSync(
      "git",
      ["apply", "--whitespace=error", path.join(directory, manifest.patch)],
      { cwd: path.join(temporary, "frameworks/base") },
    );
    const after = verifyListenerSystemui(temporary, "after", bundle);
    fs.writeFileSync(
      path.join(temporary, "derived-source.json"),
      `${JSON.stringify(after, null, 2)}\n`,
    );
    fs.mkdirSync(output); // Exclusive destination; existing source cannot be overwritten.
    fs.cpSync(temporary, output, {
      recursive: true,
      force: false,
      errorOnExist: true,
    });
    return after;
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/** Exact caller-supplied envelope for the shared full-inventory verifier. */
export function senseSystemuiPatch(bundle = "chip") {
  const directory = bundleDirectory(bundle);
  const bytes = regular(path.join(directory, "manifest.json")),
    manifest = JSON.parse(bytes);
  if (
    sha(regular(path.join(directory, manifest.patch))) !== manifest.patchSha256
  )
    throw Error("SystemUI patch hash mismatch");
  if (
    sha(regular(path.join(root, "android/sources/pixel10a-stallion.json"))) !==
    manifest.baselineLockSha256
  )
    throw Error("SystemUI baseline source lock changed");
  return {
    name: `listener-systemui-${bundle}`,
    manifest,
    manifestSha256: sha(bytes),
  };
}
