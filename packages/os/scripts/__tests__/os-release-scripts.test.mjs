// Exercises OS release pipeline scripts and evidence checks.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  defaultManifestPath,
  parseChecksumFile,
  readJson,
  sha256CanonicalJson,
  validateManifest,
  validateTeeMeasurements,
} from "../os-release-lib.mjs";
import {
  buildBoundEvidence,
  goldenMeasurementsOf,
} from "../tee-evidence-bridge.mjs";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const confidentialManifestPath = path.join(
  repoRoot,
  "release/confidential-2026-05-21/manifest.json",
);
const digest = (char) => `sha256:${char.repeat(64)}`;
const releaseFixtureTest = test;

const releaseManifestWithConfidentialTee = async () => {
  const [releaseManifest, confidentialManifest] = await Promise.all([
    readJson(defaultManifestPath),
    readJson(confidentialManifestPath),
  ]);
  return {
    ...releaseManifest,
    tee: {
      enabled: true,
      providers: [confidentialManifest.tee.provider],
      policyDigest: confidentialManifest.tee.policyDigest,
      measurements: confidentialManifest.tee.measurements,
      requiredClaims: confidentialManifest.tee.claims,
    },
  };
};

releaseFixtureTest(
  "beta manifest binds every required digital distribution class",
  async () => {
    const manifest = await readJson(defaultManifestPath);
    const result = validateManifest(manifest);

    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(manifest.release.availableDate, "2026-08-17");
    assert.equal(manifest.commerce, undefined);
    assert.deepEqual(
      new Set(manifest.release.requiredArtifactKinds),
      new Set([
        "raw-image",
        "package",
        "sbom",
        "setup-installer",
        "usb-installer",
        "signature",
        "release-metadata",
      ]),
    );
    for (const kind of manifest.release.requiredArtifactKinds) {
      assert.ok(manifest.artifacts.some((artifact) => artifact.kind === kind));
    }
    assert.ok(manifest.artifacts.every((artifact) => artifact.source));
    const linuxUsb = manifest.artifacts.find(
      (artifact) => artifact.id === "usb-installer-linux-x64",
    );
    assert.deepEqual(
      new Set(linuxUsb?.validation.requiredEvidence),
      new Set([
        "sha256-generated",
        "package-test",
        "browser-e2e",
        "virtual-block-device",
      ]),
    );
  },
);

releaseFixtureTest(
  "checked homepage downloads match the candidate end-user artifact set",
  async () => {
    const [manifest, homepage] = await Promise.all([
      readJson(defaultManifestPath),
      readJson(
        path.join(
          repoRoot,
          "homepage/public/downloads/elizaos-beta-manifest.json",
        ),
      ),
    ]);
    const publicKinds = new Set([
      "raw-image",
      "package",
      "setup-installer",
      "usb-installer",
    ]);
    assert.deepEqual(
      homepage.artifacts.map((artifact) => artifact.id),
      manifest.artifacts
        .filter((artifact) => publicKinds.has(artifact.kind))
        .map((artifact) => artifact.id),
    );
    assert.ok(
      homepage.artifacts.every(
        (artifact) => artifact.url === null && artifact.checksumUrl === null,
      ),
    );
  },
);

releaseFixtureTest(
  "all-zero sha256 placeholders are rejected even outside strict mode",
  async () => {
    const manifest = await readJson(defaultManifestPath);
    const poisoned = {
      ...manifest,
      artifacts: manifest.artifacts.map((artifact, index) =>
        index === 0
          ? { ...artifact, sha256: "0".repeat(64), sizeBytes: 1 }
          : artifact,
      ),
    };

    const lenient = validateManifest(poisoned);
    assert.equal(lenient.ok, false);
    assert.ok(
      lenient.errors.some((error) => error.includes("all-zero placeholder")),
      `expected all-zero rejection, got: ${lenient.errors.join("\n")}`,
    );

    const strict = validateManifest(poisoned, {
      requirePublishableChecksums: true,
    });
    assert.equal(strict.ok, false);
    assert.ok(
      strict.errors.some((error) => error.includes("all-zero placeholder")),
    );
    assert.ok(
      strict.errors.some((error) => error.includes("sha256 is required")),
    );
  },
);

releaseFixtureTest(
  "publishable validation requires concrete checksums and sizes",
  async () => {
    const manifest = await readJson(defaultManifestPath);
    const result = validateManifest(manifest, {
      requirePublishableChecksums: true,
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.includes("downloadUrl is required")),
    );
    assert.ok(
      result.errors.some((error) => error.includes("sha256 is required")),
    );
    assert.ok(
      result.errors.some((error) => error.includes("sizeBytes is required")),
    );
  },
);

releaseFixtureTest(
  "evidence collection resolves its directory beside the candidate manifest",
  async () => {
    const temporary = await mkdtemp(
      path.join(os.tmpdir(), "elizaos-release-evidence-"),
    );
    const candidateDirectory = path.join(temporary, "candidate");
    const manifestPath = path.join(candidateDirectory, "manifest.json");
    await mkdir(candidateDirectory, { recursive: true });
    await writeFile(manifestPath, await readFile(defaultManifestPath, "utf8"));

    await execFileAsync(
      process.execPath,
      ["scripts/collect-release-evidence.mjs", "--manifest", manifestPath],
      { cwd: repoRoot },
    );

    const reportPath = path.join(
      candidateDirectory,
      "evidence",
      "release-evidence.json",
    );
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.release.id, "elizaos-os-v0.1.0-beta.1");
    assert.equal(report.manifestValidation.ok, true);
  },
);

releaseFixtureTest(
  "release manifests reject path-escaping evidence directories",
  async () => {
    const manifest = await readJson(defaultManifestPath);
    const result = validateManifest({
      ...manifest,
      validation: { ...manifest.validation, evidenceDirectory: "../outside" },
    });
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.includes(
        "validation.evidenceDirectory must be a safe relative path",
      ),
    );
  },
);

releaseFixtureTest(
  "TEE release policy validation accepts complete measured boot policy",
  async () => {
    const manifest = await readJson(defaultManifestPath);
    const digest = `sha256:${"a".repeat(64)}`;
    const result = validateManifest({
      ...manifest,
      tee: {
        enabled: true,
        policyDigest: digest,
        measurements: {
          boot: digest,
          os: digest,
          agent: digest,
          policy: digest,
        },
        requiredClaims: {
          debugDisabled: true,
          secureBoot: true,
          memoryEncrypted: true,
        },
        providers: ["dstack", "tdx", "cove", "eliza-vault"],
      },
    });

    assert.equal(result.ok, true, result.errors.join("\n"));
  },
);

releaseFixtureTest(
  "TEE release policy validation rejects missing required production claims",
  async () => {
    const manifest = await readJson(defaultManifestPath);
    const digest = `sha256:${"a".repeat(64)}`;
    const result = validateManifest({
      ...manifest,
      tee: {
        enabled: true,
        policyDigest: digest,
        measurements: {
          boot: digest,
          os: digest,
          agent: digest,
          policy: digest,
        },
        requiredClaims: {
          debugDisabled: true,
          secureBoot: false,
        },
        providers: ["dstack"],
      },
    });

    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) =>
        error.includes("tee.requiredClaims.secureBoot"),
      ),
    );
  },
);

releaseFixtureTest(
  "checksum generation and verification round-trip local artifacts",
  async () => {
    const sourceManifest = await readJson(defaultManifestPath);
    const tmp = await mkdtemp(path.join(os.tmpdir(), "elizaos-release-"));
    const manifestPath = path.join(tmp, "manifest.json");
    const artifactRoot = path.join(tmp, "artifacts");
    await mkdir(artifactRoot, { recursive: true });

    const fixtureArtifacts = [
      sourceManifest.artifacts.find(
        (artifact) => artifact.kind === "raw-image",
      ),
      sourceManifest.artifacts.find(
        (artifact) => artifact.kind === "signature",
      ),
      sourceManifest.artifacts.find((artifact) => artifact.kind === "package"),
    ];

    const manifest = {
      ...sourceManifest,
      release: {
        ...sourceManifest.release,
        requiredArtifactKinds: ["raw-image", "signature", "package"],
      },
      artifacts: fixtureArtifacts.map((artifact) => ({
        ...artifact,
        status: "candidate",
        sizeBytes: null,
        sha256: null,
        validation: {
          ...artifact.validation,
          evidence: [],
        },
      })),
      checksumPolicy: {
        ...sourceManifest.checksumPolicy,
        generatedFile: path.join(tmp, "SHA256SUMS"),
      },
    };

    for (const artifact of manifest.artifacts) {
      await writeFile(
        path.join(artifactRoot, artifact.filename),
        `fixture payload for ${artifact.id}\n`,
      );
    }
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const checksumsPath = path.join(tmp, "SHA256SUMS");
    await execFileAsync(
      process.execPath,
      [
        "scripts/generate-release-checksums.mjs",
        "--manifest",
        manifestPath,
        "--artifact-root",
        artifactRoot,
        "--output",
        checksumsPath,
        "--update-manifest",
      ],
      { cwd: repoRoot },
    );

    const checksumRecords = parseChecksumFile(
      await readFile(checksumsPath, "utf8"),
    );
    assert.equal(checksumRecords.length, 3);

    const updated = await readJson(manifestPath);
    assert.ok(
      updated.artifacts.every((artifact) =>
        /^[a-f0-9]{64}$/.test(artifact.sha256),
      ),
    );
    assert.ok(
      updated.artifacts.every((artifact) =>
        Number.isInteger(artifact.sizeBytes),
      ),
    );

    await execFileAsync(
      process.execPath,
      [
        "scripts/verify-release-checksums.mjs",
        "--manifest",
        manifestPath,
        "--artifact-root",
        artifactRoot,
        "--checksums",
        checksumsPath,
      ],
      { cwd: repoRoot },
    );

    const checksums = await readFile(checksumsPath, "utf8");
    const firstEntry = checksumRecords[0];
    await writeFile(
      checksumsPath,
      `${checksums}${firstEntry.sha256}  ${firstEntry.filename}\n`,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/verify-release-checksums.mjs",
          "--manifest",
          manifestPath,
          "--artifact-root",
          artifactRoot,
          "--checksums",
          checksumsPath,
        ],
        { cwd: repoRoot },
      ),
      (error) => error.stderr.includes("duplicate checksum entry"),
    );

    await writeFile(
      checksumsPath,
      `${checksums}${firstEntry.sha256}  undeclared.bin\n`,
    );
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/verify-release-checksums.mjs",
          "--manifest",
          manifestPath,
          "--artifact-root",
          artifactRoot,
          "--checksums",
          checksumsPath,
        ],
        { cwd: repoRoot },
      ),
      (error) => error.stderr.includes("not declared by the manifest"),
    );

    const wrongSizeManifest = await readJson(manifestPath);
    wrongSizeManifest.artifacts[0].sizeBytes += 1;
    await writeFile(
      manifestPath,
      `${JSON.stringify(wrongSizeManifest, null, 2)}\n`,
    );
    await writeFile(checksumsPath, checksums);
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          "scripts/verify-release-checksums.mjs",
          "--manifest",
          manifestPath,
          "--artifact-root",
          artifactRoot,
          "--checksums",
          checksumsPath,
        ],
        { cwd: repoRoot },
      ),
      (error) => error.stderr.includes("size mismatch"),
    );
  },
);

test("legacy checksum updater preserves valid candidate manifest status", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "elizaos-update-sums-"));
  const manifestPath = path.join(tmp, "manifest.json");
  const artifactRoot = path.join(tmp, "artifacts");
  await mkdir(artifactRoot);

  const manifest = {
    schemaVersion: 1,
    release: {
      id: "test-release",
      channel: "beta",
      version: "2.0.0-test",
      availableDate: "2026-05-16",
      status: "candidate",
    },
    commerce: {
      usbKeyPresale: {
        enabled: true,
        priceUsd: 49,
        saleStarts: "2026-05-16",
        estimatedShipWindow: {
          starts: "2026-10-01",
          ends: "2026-10-31",
        },
      },
    },
    artifacts: [
      {
        id: "raw",
        kind: "raw-image",
        status: "candidate",
        target: { platform: "linux", architecture: "amd64" },
        filename: "raw.img.zst",
        downloadUrl: null,
        sha256: null,
        sizeBytes: null,
        validation: {
          requiredEvidence: ["sha256-generated"],
          evidence: [],
        },
      },
      {
        id: "vm",
        kind: "vm-image",
        status: "candidate",
        target: { platform: "linux", architecture: "amd64" },
        filename: "vm.ova.zip",
        downloadUrl: null,
        sha256: null,
        sizeBytes: null,
        validation: {
          requiredEvidence: ["sha256-generated"],
          evidence: [],
        },
      },
      {
        id: "android",
        kind: "android-image",
        status: "candidate",
        target: { platform: "android", architecture: "arm64" },
        filename: "android.zip",
        downloadUrl: null,
        sha256: null,
        sizeBytes: null,
        validation: {
          requiredEvidence: ["sha256-generated"],
          evidence: [],
        },
      },
    ],
    checksumPolicy: {
      algorithm: "sha256",
      generatedFile: "SHA256SUMS",
      verificationScript: "scripts/verify-release-checksums.mjs",
    },
    validation: {
      evidenceDirectory: "evidence",
      promotionGates: [],
    },
  };

  for (const artifact of manifest.artifacts) {
    await writeFile(
      path.join(artifactRoot, artifact.filename),
      `fixture payload for ${artifact.id}\n`,
    );
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  await execFileAsync(
    process.execPath,
    [
      "scripts/update-manifest-checksums.mjs",
      "--manifest",
      manifestPath,
      "--artifacts-dir",
      artifactRoot,
    ],
    { cwd: repoRoot },
  );

  const updated = await readJson(manifestPath);
  assert.deepEqual(
    updated.artifacts.map((artifact) => artifact.status),
    ["candidate", "candidate", "candidate"],
  );
  assert.ok(
    updated.artifacts.every((artifact) =>
      artifact.validation.evidence.includes("sha256-generated"),
    ),
  );
  assert.equal(
    updated.artifacts.every((artifact) =>
      /^[a-f0-9]{64}$/.test(artifact.sha256),
    ),
    true,
  );

  const validation = validateManifest(updated);
  assert.equal(validation.ok, true, validation.errors.join("\n"));
});

test("TEE measurement generation hashes required release inputs", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "elizaos-tee-"));
  const inputs = {
    boot: path.join(tmp, "boot.bin"),
    os: path.join(tmp, "os.img"),
    agent: path.join(tmp, "agent.tar"),
    policy: path.join(tmp, "policy.json"),
    container: path.join(tmp, "compose.json"),
  };
  for (const [name, filePath] of Object.entries(inputs)) {
    // `policy` is hashed as canonicalized JSON (it is the source of
    // measurements.policy), so it must be valid JSON; the rest hash raw bytes.
    const contents =
      name === "policy"
        ? JSON.stringify({ z: 1, a: { b: 2 } })
        : `fixture for ${name}\n`;
    await writeFile(filePath, contents);
  }
  const output = path.join(tmp, "tee-measurements.json");

  await execFileAsync(
    process.execPath,
    [
      "scripts/generate-tee-measurements.mjs",
      "--output",
      output,
      "--boot",
      inputs.boot,
      "--os",
      inputs.os,
      "--agent",
      inputs.agent,
      "--policy",
      inputs.policy,
      "--container",
      inputs.container,
    ],
    { cwd: repoRoot },
  );

  const generated = await readJson(output);
  assert.equal(generated.schemaVersion, 1);
  for (const name of Object.keys(inputs)) {
    assert.match(generated.measurements[name], /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(validateTeeMeasurements(generated).ok, true);
  // The policy measurement is the canonical-JSON digest, independent of key
  // order in the source file.
  assert.equal(
    generated.measurements.policy,
    sha256CanonicalJson({ z: 1, a: { b: 2 } }),
  );
});

test("TEE measurement validator rejects missing required digests", () => {
  const result = validateTeeMeasurements({
    schemaVersion: 1,
    generatedBy: "test",
    measurements: {
      boot: `sha256:${"a".repeat(64)}`,
      os: `sha256:${"b".repeat(64)}`,
      agent: "bad",
      policy: `sha256:${"d".repeat(64)}`,
    },
  });

  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("measurements.agent")),
  );
});

releaseFixtureTest(
  "confidential manifest with a valid TEE block validates",
  async () => {
    const manifest = await releaseManifestWithConfidentialTee();
    const result = validateManifest(manifest);
    assert.equal(result.ok, true, result.errors.join("\n"));
    assert.equal(manifest.tee.enabled, true);
    for (const name of ["boot", "os", "agent", "policy"]) {
      assert.match(manifest.tee.measurements[name], /^sha256:[a-f0-9]{64}$/);
    }
  },
);

releaseFixtureTest(
  "manifest declaring TEE but missing a required digest fails closed",
  async () => {
    const manifest = await releaseManifestWithConfidentialTee();
    const broken = {
      ...manifest,
      tee: {
        ...manifest.tee,
        measurements: { ...manifest.tee.measurements, agent: undefined },
      },
    };
    const result = validateManifest(broken);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.includes("tee.measurements.agent")),
      result.errors.join("\n"),
    );
  },
);

releaseFixtureTest(
  "manifest declaring an inference measurement must assert npuProtected + ioProtected",
  async () => {
    const manifest = await releaseManifestWithConfidentialTee();
    const broken = {
      ...manifest,
      tee: {
        ...manifest.tee,
        requiredClaims: {
          ...manifest.tee.requiredClaims,
          npuProtected: false,
          ioProtected: false,
        },
      },
    };
    const result = validateManifest(broken);
    assert.equal(result.ok, false);
    assert.ok(
      result.errors.some((error) => error.includes("npuProtected")),
      result.errors.join("\n"),
    );
    assert.ok(
      result.errors.some((error) => error.includes("ioProtected")),
      result.errors.join("\n"),
    );
  },
);

releaseFixtureTest(
  "TEE block rejects unknown / malformed measurement names",
  async () => {
    const manifest = await releaseManifestWithConfidentialTee();
    const unknownName = {
      ...manifest,
      tee: {
        ...manifest.tee,
        measurements: { ...manifest.tee.measurements, bogus: digest("a") },
      },
    };
    const unknownResult = validateManifest(unknownName);
    assert.equal(unknownResult.ok, false);
    assert.ok(
      unknownResult.errors.some((error) =>
        error.includes("tee.measurements.bogus"),
      ),
    );

    const malformed = {
      ...manifest,
      tee: {
        ...manifest.tee,
        measurements: { ...manifest.tee.measurements, monitor: "deadbeef" },
      },
    };
    const malformedResult = validateManifest(malformed);
    assert.equal(malformedResult.ok, false);
    assert.ok(
      malformedResult.errors.some((error) =>
        error.includes("tee.measurements.monitor"),
      ),
    );
  },
);

test("new measurement names round-trip through generate -> validate", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "elizaos-tee-rt-"));
  const names = [
    "boot",
    "os",
    "agent",
    "policy",
    "device",
    "container",
    "compose",
    "gpuFirmware",
    "npuFirmware",
    "modelWeights",
    "monitor",
  ];
  const cliArgs = [
    "scripts/generate-tee-measurements.mjs",
    "--output",
    path.join(tmp, "out.json"),
  ];
  for (const name of names) {
    const filePath = path.join(tmp, `${name}.bin`);
    // `policy` is canonicalized JSON (source of measurements.policy); the rest
    // hash raw component bytes.
    await writeFile(
      filePath,
      name === "policy" ? JSON.stringify({ k: name }) : `fixture for ${name}\n`,
    );
    cliArgs.push(`--${name}`, filePath);
  }

  await execFileAsync(process.execPath, cliArgs, { cwd: repoRoot });
  const generated = await readJson(path.join(tmp, "out.json"));
  for (const name of names) {
    assert.match(generated.measurements[name], /^sha256:[a-f0-9]{64}$/);
  }
  assert.equal(validateTeeMeasurements(generated).ok, true);
});

test("standalone measurements validator rejects an unknown measurement name", () => {
  const result = validateTeeMeasurements({
    schemaVersion: 1,
    generatedBy: "test",
    measurements: {
      boot: digest("a"),
      os: digest("b"),
      agent: digest("c"),
      policy: digest("d"),
      mystery: digest("e"),
    },
  });
  assert.equal(result.ok, false);
  assert.ok(
    result.errors.some((error) => error.includes("measurements.mystery")),
  );
});

releaseFixtureTest(
  "evidence bridge emits a normalized shape bound to golden measurements",
  async () => {
    const manifest = await readJson(confidentialManifestPath);
    const golden = goldenMeasurementsOf(manifest);
    const evidence = await readJson(
      path.join(repoRoot, "release/schema/tee-evidence.mock.json"),
    );

    const bound = buildBoundEvidence(evidence, golden);
    assert.equal(bound.kind, "dstack");
    assert.equal(bound.provider, "dstack");
    assert.equal(bound.measurements.os, golden.os);
    assert.equal(bound.claims.npuProtected, true);
    assert.equal(bound.claims.ioProtected, true);
    assert.match(bound.reportData, /^sha256:[a-f0-9]{64}$/);
    for (const name of ["boot", "os", "agent", "policy"]) {
      assert.match(bound.measurements[name], /^sha256:[a-f0-9]{64}$/);
    }
  },
);

releaseFixtureTest(
  "evidence bridge fails closed on a runtime-vs-golden mismatch",
  async () => {
    const manifest = await readJson(confidentialManifestPath);
    const golden = goldenMeasurementsOf(manifest);
    const tampered = await readJson(
      path.join(repoRoot, "release/schema/tee-evidence.tampered.mock.json"),
    );

    assert.throws(
      () => buildBoundEvidence(tampered, golden),
      /measurement-mismatch/,
    );
  },
);

test("evidence bridge rejects an unknown runtime measurement name", () => {
  const golden = {
    boot: digest("b"),
    os: digest("c"),
    agent: digest("d"),
    policy: digest("a"),
  };
  const evidence = {
    kind: "dstack",
    measurements: { ...golden, bogus: digest("e") },
  };
  assert.throws(
    () => buildBoundEvidence(evidence, golden),
    /unknown runtime measurement/,
  );
});

test("evidence bridge CLI fails closed when real hardware quote is requested", async () => {
  await assert.rejects(
    execFileAsync(
      process.execPath,
      ["scripts/tee-evidence-bridge.mjs", "--quote-source", "tappd"],
      { cwd: repoRoot },
    ),
    (error) => {
      assert.equal(error.code, 2);
      assert.match(error.stderr, /BLOCKED/);
      assert.match(error.stderr, /--quote-source tappd/);
      return true;
    },
  );
});
