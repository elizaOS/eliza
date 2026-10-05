/** Verifies that cached iOS fused archives and their public FFI header belong to the recorded native source revision. */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function sha256File(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function recordFusedSliceProvenance({
  sourceRevision,
  sourceClean,
  sourceHeader,
  outDir,
  archives,
}) {
  if (!sourceClean || !/^[a-f0-9]{40}$/.test(sourceRevision)) return null;
  const header = path.join(outDir, "include", "eliza-inference-ffi.h");
  const headerSha256 = sha256File(sourceHeader);
  if (sha256File(header) !== headerSha256) {
    throw new Error(
      "Staged iOS FFI header differs from the compiled native source header",
    );
  }
  if (
    !archives.some(
      (file) => path.basename(file) === "libeliza_voice_classifiers.a",
    )
  ) {
    throw new Error(
      "Fused iOS archive inventory omits its voice-classifier dependency",
    );
  }
  return {
    version: 2,
    sourceRevision,
    headerSha256,
    archives: Object.fromEntries(
      archives.map((file) => [path.basename(file), sha256File(file)]),
    ),
  };
}

export function fusedSliceCacheMatches({
  outDir,
  target,
  sourceRevision,
  sourceClean,
  sourceHeader,
}) {
  if (!sourceClean || !/^[a-f0-9]{40}$/.test(sourceRevision)) return false;
  try {
    const capabilities = JSON.parse(
      fs.readFileSync(path.join(outDir, "CAPABILITIES.json"), "utf8"),
    );
    const proof = capabilities.fusedProvenance;
    if (
      capabilities.target !== target ||
      proof?.version !== 2 ||
      proof.sourceRevision !== sourceRevision
    )
      return false;
    const headerSha256 = sha256File(sourceHeader);
    if (
      proof.headerSha256 !== headerSha256 ||
      sha256File(path.join(outDir, "include", "eliza-inference-ffi.h")) !==
        headerSha256
    )
      return false;
    if (
      !Array.isArray(capabilities.archives) ||
      !capabilities.archives.includes("libeliza_voice_classifiers.a") ||
      !proof.archives ||
      typeof proof.archives !== "object"
    )
      return false;
    if (Object.keys(proof.archives).length !== capabilities.archives.length)
      return false;
    return capabilities.archives.every(
      (name) =>
        typeof name === "string" &&
        path.basename(name) === name &&
        name.endsWith(".a") &&
        typeof proof.archives[name] === "string" &&
        sha256File(path.join(outDir, name)) === proof.archives[name],
    );
  } catch {
    // error-policy:J3 Missing, stale or malformed local cache evidence requires rebuilding the slice.
    return false;
  }
}
