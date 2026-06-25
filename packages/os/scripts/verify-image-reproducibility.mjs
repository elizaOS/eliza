#!/usr/bin/env node
// OS-5 gate: confidential-image-reproducibility (plan §1.3/§2.2, §7.2 OS-5).
//
// The reproducibility property OS-5 must prove is: rebuilding the confidential
// guest image from the pinned inputs (meta-dstack repro-build + meta-elizaos)
// yields byte-identical components, hence identical measurement registers, hence
// the same golden tee-measurements.json. A verifier can then recompute the
// golden digests offline and a relying party never has to trust the builder.
//
// This script proves the parts of OS-5 that are real WITHOUT a multi-hour Yocto
// build (which is BLOCKED: meta-dstack is not vendored and there is no TDX build
// host here — see packages/os/linux/confidential/repro-build/README.md):
//
//   recompute mode (--input M [--components-dir DIR]):
//     For every declared component (kernel/initrd/rootfs/appCompose) whose file
//     is present under DIR, recompute sha256 over the REAL bytes and assert it
//     equals the manifest's declared digest. A drifted byte fails closed. With
//     no DIR, or when a file is absent, that component is reported UNVERIFIED
//     (not silently passed) and the run fails unless --allow-absent is set.
//
//   double-build mode (--build-a A --build-b B):
//     The core reproducibility property. Assert every component digest AND every
//     declared measurement digest in build A equals build B. Any difference is a
//     non-reproducible build and fails closed. Optionally recompute both against
//     their --components-dir-a / --components-dir-b when present.
//
// Reproducibility confirmation gate (fail-closed): a manifest whose
// reproducibility.confirmed is true MUST carry a reproBuildContext and MUST pass
// recomputation against real component bytes. confirmed=false is BLOCKED (exit 3)
// — correct data that is not yet production-ready — mirroring the dstack-pins /
// aggregate pattern. A confirmed=true manifest that cannot be recomputed (no
// bytes, or a mismatch) is a hard FAIL (exit 1): a reproducibility claim with no
// backing transcript is exactly what the repo's status discipline forbids.
//
// Runner: plain `node` (no third-party deps). node --test for the tests.
//   node packages/os/scripts/verify-image-reproducibility.mjs --input <manifest>
//   node packages/os/scripts/verify-image-reproducibility.mjs --build-a A --build-b B
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  fileExists,
  parseArgs,
  readJson,
  repoRoot,
  sha256File,
} from "./os-release-lib.mjs";

const COMPONENT_NAMES = ["kernel", "initrd", "rootfs", "appCompose"];
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;

// Recompute every component digest declared in `manifest` from real bytes under
// `componentsDir`. Returns { ok, blocked, errors, verified, unverified }.
//   - verified:   components whose recomputed sha256 matched the declared digest.
//   - unverified: components whose file was absent (recompute impossible).
// A declared digest that does not match the bytes is a hard error.
export async function recomputeComponents(
  manifest,
  componentsDir,
  { allowAbsent = false } = {},
) {
  const errors = [];
  const verified = [];
  const unverified = [];

  for (const name of COMPONENT_NAMES) {
    const component = manifest.components?.[name];
    const declared = component?.digest;
    if (!DIGEST_PATTERN.test(String(declared))) {
      errors.push(`components.${name}.digest is not a sha256 digest`);
      continue;
    }
    if (!componentsDir) {
      unverified.push(name);
      continue;
    }
    const filePath = path.resolve(componentsDir, component.filename);
    if (!(await fileExists(filePath))) {
      unverified.push(name);
      continue;
    }
    const recomputed = `sha256:${await sha256File(filePath)}`;
    if (recomputed !== declared) {
      errors.push(
        `components.${name}: recomputed ${recomputed} != declared ${declared} ` +
          `(file ${component.filename}) — image is NOT reproducible / manifest drifted`,
      );
    } else {
      verified.push(name);
    }
  }

  if (!allowAbsent && unverified.length > 0) {
    errors.push(
      `components UNVERIFIED (no bytes to recompute): ${unverified.join(", ")}. ` +
        `Provide --components-dir with the built component files, or pass --allow-absent ` +
        `to acknowledge a shape-only check.`,
    );
  }

  return { ok: errors.length === 0, errors, verified, unverified };
}

// Single-manifest verification. confirmed=false ⇒ BLOCKED (exit 3); confirmed=true
// requires real recomputation (bytes present + match), else hard FAIL.
export async function verifyManifest(
  manifest,
  componentsDir,
  { allowAbsent = false } = {},
) {
  const confirmed = manifest.reproducibility?.confirmed === true;

  if (confirmed) {
    const context = manifest.reproducibility?.reproBuildContext;
    if (typeof context !== "string" || context.length === 0) {
      return {
        ok: false,
        blocked: false,
        errors: [
          "reproducibility.confirmed is true but reproBuildContext is missing: " +
            "a confirmed reproducible build MUST name the repro-build context. FAIL-CLOSED.",
        ],
        verified: [],
        unverified: [],
      };
    }
    // A confirmed build must be recomputable from real bytes — no --allow-absent
    // escape, because a confirmed claim with nothing to recompute is a fabricated
    // "reproducible" claim, which the status discipline forbids.
    const recompute = await recomputeComponents(manifest, componentsDir, {
      allowAbsent: false,
    });
    if (!recompute.ok) {
      return { ...recompute, blocked: false };
    }
    return { ...recompute, blocked: false };
  }

  // confirmed === false: BLOCKED. Still recompute anything present so a drifted
  // fixture is caught even before the build is confirmed, but absence is allowed.
  const recompute = await recomputeComponents(manifest, componentsDir, {
    allowAbsent: true,
  });
  if (!recompute.ok) {
    return { ...recompute, blocked: false };
  }
  return {
    ok: false,
    blocked: true,
    errors: [
      "reproducibility.confirmed is false: the reproducible image build is " +
        "BLOCKED (gate confidential-image-reproducibility / OS-5). " +
        `blockedOn: ${manifest.reproducibility?.note ?? manifest.gate?.blockedOn ?? "see repro-build/README.md"}`,
    ],
    verified: recompute.verified,
    unverified: recompute.unverified,
  };
}

// Double-build digest equality: the core reproducibility property. Every declared
// component digest and every declared measurement digest in build A must equal
// build B. componentsDirA/B, when given, additionally recompute each manifest
// against its own bytes so neither manifest can lie about its own digests.
export async function compareDoubleBuild(
  manifestA,
  manifestB,
  { componentsDirA, componentsDirB, allowAbsent = false } = {},
) {
  const errors = [];

  for (const name of COMPONENT_NAMES) {
    const a = manifestA.components?.[name]?.digest;
    const b = manifestB.components?.[name]?.digest;
    if (!DIGEST_PATTERN.test(String(a)) || !DIGEST_PATTERN.test(String(b))) {
      errors.push(`components.${name}: missing/invalid digest in build A or B`);
      continue;
    }
    if (a !== b) {
      errors.push(
        `components.${name}: build A ${a} != build B ${b} — NOT reproducible`,
      );
    }
  }

  // Compare the full union of declared measurement keys so a measurement present
  // in only one build (asymmetric drift) is also caught.
  const measureKeys = new Set([
    ...Object.keys(manifestA.measurements ?? {}),
    ...Object.keys(manifestB.measurements ?? {}),
  ]);
  for (const name of measureKeys) {
    const a = manifestA.measurements?.[name];
    const b = manifestB.measurements?.[name];
    if (a !== b) {
      errors.push(
        `measurements.${name}: build A ${a ?? "(absent)"} != build B ${b ?? "(absent)"} — NOT reproducible`,
      );
    }
  }

  // Recompute each build against its own bytes when provided.
  const recomputeA = await recomputeComponents(manifestA, componentsDirA, {
    allowAbsent,
  });
  const recomputeB = await recomputeComponents(manifestB, componentsDirB, {
    allowAbsent,
  });
  for (const e of recomputeA.errors) errors.push(`build A: ${e}`);
  for (const e of recomputeB.errors) errors.push(`build B: ${e}`);

  return {
    ok: errors.length === 0,
    errors,
    verifiedA: recomputeA.verified,
    verifiedB: recomputeB.verified,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const allowAbsent = args["allow-absent"] === true;

  if (
    typeof args["build-a"] === "string" ||
    typeof args["build-b"] === "string"
  ) {
    if (
      typeof args["build-a"] !== "string" ||
      typeof args["build-b"] !== "string"
    ) {
      console.error(
        "error: double-build mode needs both --build-a and --build-b",
      );
      process.exit(2);
    }
    const [manifestA, manifestB] = await Promise.all([
      readJson(args["build-a"]),
      readJson(args["build-b"]),
    ]);
    const result = await compareDoubleBuild(manifestA, manifestB, {
      componentsDirA:
        typeof args["components-dir-a"] === "string"
          ? args["components-dir-a"]
          : undefined,
      componentsDirB:
        typeof args["components-dir-b"] === "string"
          ? args["components-dir-b"]
          : undefined,
      allowAbsent,
    });
    if (!result.ok) {
      for (const error of result.errors) console.error(`error: ${error}`);
      console.error(
        "confidential-image-reproducibility (double-build): FAIL-CLOSED",
      );
      process.exit(1);
    }
    console.log(
      `confidential-image-reproducibility (double-build): REPRODUCIBLE — ` +
        `all component + measurement digests of build A and build B are identical`,
    );
    if (result.verifiedA.length > 0 || result.verifiedB.length > 0) {
      console.log(
        `  recomputed from real bytes: A=[${result.verifiedA.join(", ")}] B=[${result.verifiedB.join(", ")}]`,
      );
    }
    return;
  }

  const input =
    typeof args.input === "string"
      ? args.input
      : path.join(
          repoRoot,
          "packages/os/linux/confidential/image-manifest.example.json",
        );
  const componentsDir =
    typeof args["components-dir"] === "string"
      ? args["components-dir"]
      : undefined;
  const manifest = await readJson(input);
  const result = await verifyManifest(manifest, componentsDir, { allowAbsent });

  if (!result.ok && !result.blocked) {
    for (const error of result.errors) console.error(`error: ${error}`);
    console.error("confidential-image-reproducibility: FAIL-CLOSED");
    process.exit(1);
  }
  if (result.blocked) {
    for (const error of result.errors) console.error(`  ${error}`);
    if (result.verified.length > 0) {
      console.error(
        `  (recomputed-and-matched: ${result.verified.join(", ")})`,
      );
    }
    console.error("confidential-image-reproducibility: BLOCKED (exit 3)");
    process.exit(3);
  }
  console.log(
    `confidential-image-reproducibility: CONFIRMED — recomputed from real bytes: ` +
      `${result.verified.join(", ")} (${input})`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
