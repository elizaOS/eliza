// OS-5 confidential-image-reproducibility tests.
// Runner: node --test (bun test segfaults on the OS lane in this environment).
//   node --test packages/os/scripts/__tests__/verify-image-reproducibility.test.mjs
//
// These tests prove the reproducibility HARNESS works against real bytes without
// a full Yocto build: a deterministically-generated component set is hashed,
// turned into a manifest twice, and the verifier must report REPRODUCIBLE; a
// one-byte drift must FAIL CLOSED.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  compareDoubleBuild,
  recomputeComponents,
  verifyManifest,
} from "../verify-image-reproducibility.mjs";

const sha256 = (buf) =>
  `sha256:${createHash("sha256").update(buf).digest("hex")}`;

// Deterministic component bytes — same inputs => same bytes => same digest.
// This stands in for "two reproducible builds produce identical components".
function deterministicComponents(seed = "elizaos-confidential") {
  return {
    kernel: { filename: "bzImage", bytes: Buffer.from(`${seed}::kernel`) },
    initrd: {
      filename: "initramfs.cpio.zst",
      bytes: Buffer.from(`${seed}::initrd`),
    },
    rootfs: {
      filename: "rootfs.squashfs",
      bytes: Buffer.from(`${seed}::rootfs`),
    },
    appCompose: {
      filename: "app-compose.json",
      bytes: Buffer.from(`${seed}::compose`),
    },
  };
}

const MEASURED_INTO = {
  kernel: "RTMR1",
  initrd: "RTMR2",
  rootfs: "rootfs-hash (dm-verity root)",
  appCompose: "RTMR3",
};

// Write the component bytes to disk and build a manifest whose declared digests
// are the real sha256 of those bytes — mirroring generate-tee-measurements.mjs.
async function buildFixture(
  dir,
  components,
  { confirmed } = { confirmed: false },
) {
  const manifestComponents = {};
  for (const [name, { filename, bytes }] of Object.entries(components)) {
    await writeFile(path.join(dir, filename), bytes);
    manifestComponents[name] = {
      filename,
      digest: sha256(bytes),
      measuredInto: MEASURED_INTO[name],
    };
  }
  const composeDigest = manifestComponents.appCompose.digest;
  const rootfsDigest = manifestComponents.rootfs.digest;
  return {
    schemaVersion: 1,
    generatedBy: "verify-image-reproducibility.test",
    summary: "deterministic test fixture",
    image: {
      profile: "confidential",
      substrate: "tdx",
      builder: "meta-dstack",
      architecture: "x86_64",
    },
    components: manifestComponents,
    buildInputs: {
      toolchain: [
        { name: "poky", version: "scarthgap", sha256: "a".repeat(64) },
      ],
      layers: [
        {
          name: "meta-dstack",
          repo: "https://github.com/Dstack-TEE/meta-dstack",
          commit: "1".repeat(40),
        },
      ],
    },
    measurements: {
      boot: sha256(Buffer.from("boot")),
      os: rootfsDigest,
      policy: sha256(Buffer.from("policy")),
      agent: sha256(Buffer.from("agent")),
      compose: composeDigest,
    },
    reproducibility: {
      confirmed,
      reproBuildContext: "packages/os/linux/confidential/repro-build/",
      note: confirmed ? "double-build confirmed" : "BLOCKED on build host",
    },
    gate: {
      name: "confidential-image-manifest-check",
      blockedOn: "build host",
      provingCommand:
        "node packages/os/scripts/verify-image-reproducibility.mjs",
    },
  };
}

let workDir;
test.before(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "repro-os5-"));
});
test.after(async () => {
  if (workDir) await rm(workDir, { recursive: true, force: true });
});

test("reproducible: two builds of the same deterministic inputs are byte-identical", async () => {
  const dirA = path.join(workDir, "buildA");
  const dirB = path.join(workDir, "buildB");
  await rm(dirA, { recursive: true, force: true });
  await rm(dirB, { recursive: true, force: true });
  await import("node:fs/promises").then((m) =>
    Promise.all([m.mkdir(dirA), m.mkdir(dirB)]),
  );

  const manifestA = await buildFixture(dirA, deterministicComponents());
  const manifestB = await buildFixture(dirB, deterministicComponents());

  // Independent of files, the declared digests must match (the property).
  const result = await compareDoubleBuild(manifestA, manifestB, {
    componentsDirA: dirA,
    componentsDirB: dirB,
  });
  assert.equal(result.ok, true, result.errors.join("\n"));
  // And both were recomputed from real bytes, not just compared as strings.
  assert.deepEqual([...result.verifiedA].sort(), [
    "appCompose",
    "initrd",
    "kernel",
    "rootfs",
  ]);
});

test("drift: a one-byte change in build B is caught and FAILS CLOSED", async () => {
  const dirA = path.join(workDir, "driftA");
  const dirB = path.join(workDir, "driftB");
  await import("node:fs/promises").then((m) =>
    Promise.all([
      m.mkdir(dirA, { recursive: true }),
      m.mkdir(dirB, { recursive: true }),
    ]),
  );

  const manifestA = await buildFixture(dirA, deterministicComponents());
  // Mutate one byte of the rootfs in build B's inputs.
  const driftedComponents = deterministicComponents();
  driftedComponents.rootfs.bytes = Buffer.from("elizaos-confidential::rootfs!");
  const manifestB = await buildFixture(dirB, driftedComponents);

  const result = await compareDoubleBuild(manifestA, manifestB, {
    componentsDirA: dirA,
    componentsDirB: dirB,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) => e.includes("components.rootfs") && e.includes("NOT reproducible"),
    ),
    result.errors.join("\n"),
  );
  // The os measurement (derived from rootfs) must also diverge.
  assert.ok(result.errors.some((e) => e.includes("measurements.os")));
});

test("missing component file: recompute reports it UNVERIFIED and FAILS without --allow-absent", async () => {
  const dir = path.join(workDir, "missing");
  await import("node:fs/promises").then((m) =>
    m.mkdir(dir, { recursive: true }),
  );
  const components = deterministicComponents();
  const manifest = await buildFixture(dir, components);
  // Remove the kernel file so it cannot be recomputed.
  await rm(path.join(dir, components.kernel.filename));

  const strict = await recomputeComponents(manifest, dir, {
    allowAbsent: false,
  });
  assert.equal(strict.ok, false);
  assert.ok(strict.unverified.includes("kernel"), JSON.stringify(strict));
  assert.ok(strict.errors.some((e) => e.includes("UNVERIFIED")));

  // A confirmed=true manifest with a missing file is a hard FAIL (no fabricated claim).
  const confirmedManifest = {
    ...manifest,
    reproducibility: { ...manifest.reproducibility, confirmed: true },
  };
  const verified = await verifyManifest(confirmedManifest, dir);
  assert.equal(verified.ok, false);
  assert.equal(verified.blocked, false);
});

test("recompute mismatch: a declared digest that lies about its bytes FAILS CLOSED", async () => {
  const dir = path.join(workDir, "mismatch");
  await import("node:fs/promises").then((m) =>
    m.mkdir(dir, { recursive: true }),
  );
  const components = deterministicComponents();
  const manifest = await buildFixture(dir, components);
  // Tamper the declared digest so it no longer matches the real bytes on disk.
  manifest.components.initrd.digest = sha256(
    Buffer.from("a different payload"),
  );

  const result = await recomputeComponents(manifest, dir, {
    allowAbsent: false,
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some(
      (e) =>
        e.includes("components.initrd") &&
        e.includes("recomputed") &&
        e.includes("declared"),
    ),
    result.errors.join("\n"),
  );
});

test("confirmed=false is BLOCKED (not a hard fail), but present drift still hard-FAILS", async () => {
  const dir = path.join(workDir, "blocked");
  await import("node:fs/promises").then((m) =>
    m.mkdir(dir, { recursive: true }),
  );
  const manifest = await buildFixture(dir, deterministicComponents(), {
    confirmed: false,
  });

  // No components dir: confirmed=false => BLOCKED, absence allowed.
  const blocked = await verifyManifest(manifest, undefined);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.errors.some((e) => e.includes("BLOCKED")));

  // Even while BLOCKED, a present-but-drifted byte is a hard fail, not a block.
  const drifted = {
    ...manifest,
    components: JSON.parse(JSON.stringify(manifest.components)),
  };
  drifted.components.kernel.digest = sha256(Buffer.from("wrong"));
  const hardFail = await verifyManifest(drifted, dir);
  assert.equal(hardFail.ok, false);
  assert.equal(hardFail.blocked, false);
});

test("confirmed=true with byte-backed recompute is CONFIRMED", async () => {
  const dir = path.join(workDir, "confirmed");
  await import("node:fs/promises").then((m) =>
    m.mkdir(dir, { recursive: true }),
  );
  const manifest = await buildFixture(dir, deterministicComponents(), {
    confirmed: true,
  });
  const result = await verifyManifest(manifest, dir);
  assert.equal(result.ok, true, result.errors.join("\n"));
  assert.equal(result.blocked, false);
  assert.equal(result.verified.length, 4);
});
