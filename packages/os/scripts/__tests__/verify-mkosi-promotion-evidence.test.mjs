import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { zstdCompressSync } from "node:zlib";

const script = new URL(
  "../verify-mkosi-promotion-evidence.mjs",
  import.meta.url,
);
const sourceSha = "a".repeat(40);

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fixture(architecture = "x86_64") {
  const buildArchitecture = architecture === "x86_64" ? "amd64" : architecture;
  const root = await mkdtemp(path.join(tmpdir(), "mkosi-promotion-"));
  const expandedBytes = Buffer.alloc(4096, 7);
  const compressedBytes = zstdCompressSync(expandedBytes);
  const compressed = path.join(root, "elizaos-1.0.0-x86_64.raw.zst");
  const expanded = path.join(root, "elizaos-1.0.0-x86_64.raw");
  const buildEvidence = path.join(root, "build.json");
  const qemuEvidence = path.join(root, "qemu.json");
  const legacyBiosEvidence = path.join(root, "qemu-legacy-bios.json");
  const persistenceEvidence = path.join(root, "persistence.json");
  const sbom = path.join(root, "image.spdx.json");
  await Promise.all([
    writeFile(compressed, compressedBytes),
    writeFile(expanded, expandedBytes),
    writeFile(
      buildEvidence,
      JSON.stringify({
        schema: "ai.elizaos.mkosi-build-evidence.v1",
        claimBoundary: "mkosi_disk_assembly_only_no_boot_or_hardware_claim",
        success: true,
        preflightOnly: false,
        buildMode: "release",
        sourceDirty: false,
        sourceCommit: sourceSha,
        architecture: buildArchitecture,
        artifacts: [
          {
            path: "/build/elizaos-linux-x86-64.raw.zst",
            size: compressedBytes.length,
            sha256: sha256(compressedBytes),
          },
        ],
      }),
    ),
    writeFile(
      qemuEvidence,
      JSON.stringify({
        schema: "ai.elizaos.mkosi-qemu-evidence.v1",
        claimBoundary:
          "qemu_graphical_target_only_no_login_agent_computer_control_or_hardware_claim",
        success: true,
        preflightOnly: false,
        architecture: buildArchitecture,
        diskInterface: "usb",
        firmwareMode: "pflash",
        emulator: {
          path: "/usr/bin/qemu-system-x86_64",
          version: "QEMU 11.1.0",
        },
        terminationReason: "required-markers",
        markersFound: ["Linux version", "Reached target Graphical Interface"],
        forbiddenMarkersFound: [],
        inputs: {
          image: { size: expandedBytes.length, sha256: sha256(expandedBytes) },
          firmwareCode: { sha256: "c".repeat(64) },
          firmwareVarsTemplate: { sha256: "d".repeat(64) },
        },
      }),
    ),
    writeFile(
      legacyBiosEvidence,
      JSON.stringify({
        schema: "ai.elizaos.mkosi-qemu-evidence.v1",
        claimBoundary:
          "qemu_graphical_target_only_no_login_agent_computer_control_or_hardware_claim",
        success: true,
        preflightOnly: false,
        architecture: buildArchitecture,
        diskInterface: "usb",
        firmwareMode: "bios",
        emulator: {
          path: "/usr/bin/qemu-system-x86_64",
          version: "QEMU 11.1.0",
        },
        terminationReason: "required-markers",
        markersFound: ["Linux version", "Reached target Graphical Interface"],
        forbiddenMarkersFound: [],
        inputs: {
          image: { size: expandedBytes.length, sha256: sha256(expandedBytes) },
          bios: { sha256: "e".repeat(64) },
        },
      }),
    ),
    writeFile(
      persistenceEvidence,
      JSON.stringify({
        schema: "ai.elizaos.mkosi-persistence-evidence.v1",
        claimBoundary:
          "virtual_usb_write_readback_and_two_boot_home_persistence_no_installer_desktop_or_physical_hardware_claim",
        success: true,
        preflightOnly: false,
        architecture: buildArchitecture,
        sourceImage: {
          size: expandedBytes.length,
          sha256: sha256(expandedBytes),
        },
        virtualUsbReadback: {
          bytes: expandedBytes.length,
          sha256: sha256(expandedBytes),
          interface: "loop-block-written-then-qemu-removable-usb",
        },
        home: {
          partitionBytesBefore: 1024,
          partitionBytesAfter: 2048,
          filesystemBytesBefore: 900,
          filesystemBytesAfter: 1900,
          sentinelSha256: "b".repeat(64),
          survivedSecondBoot: true,
        },
        boots: [1, 2].map((number) => ({
          success: true,
          terminationReason: "guest-poweroff",
          returnCode: 0,
          shutdownError: null,
          markersFound: ["Linux version", "Reached target Graphical Interface"],
          forbiddenMarkersFound: [],
          transcript: { size: number, sha256: String(number).repeat(64) },
        })),
      }),
    ),
    writeFile(
      sbom,
      JSON.stringify({
        spdxVersion: "SPDX-2.3",
        packages: [{ name: "systemd", SPDXID: "SPDXRef-Package-systemd" }],
      }),
    ),
  ]);
  return {
    root,
    architecture,
    compressed,
    expanded,
    buildEvidence,
    qemuEvidence,
    legacyBiosEvidence: architecture === "x86_64" ? legacyBiosEvidence : undefined,
    persistenceEvidence,
    sbom,
  };
}

function verify(paths) {
  const legacyBiosArgs = paths.legacyBiosEvidence
    ? ["--legacy-bios-evidence", paths.legacyBiosEvidence]
    : [];
  return spawnSync(
    process.execPath,
    [
      script.pathname,
      "--architecture",
      paths.architecture,
      "--compressed",
      paths.compressed,
      "--expanded",
      paths.expanded,
      "--build-evidence",
      paths.buildEvidence,
      "--qemu-evidence",
      paths.qemuEvidence,
      ...legacyBiosArgs,
      "--persistence-evidence",
      paths.persistenceEvidence,
      "--sbom",
      paths.sbom,
      "--source-sha",
      sourceSha,
    ],
    { encoding: "utf8" },
  );
}

test("promotion verifier binds exact build, QEMU USB, and SPDX bytes", async () => {
  const paths = await fixture();
  const result = verify(paths);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).architecture, "x86_64");
});

test("promotion rejects a built archive that expands to a different qualified image", async () => {
  const paths = await fixture();
  const differentArchive = zstdCompressSync(Buffer.alloc(4096, 8));
  await writeFile(paths.compressed, differentArchive);
  const build = JSON.parse(await readFile(paths.buildEvidence, "utf8"));
  build.artifacts[0].sha256 = sha256(differentArchive);
  build.artifacts[0].size = differentArchive.length;
  await writeFile(paths.buildEvidence, JSON.stringify(build));
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not decompress to the qualified expanded image/);
});

test("promotion rejects corrupt compressed bytes even with matching build evidence", async () => {
  const paths = await fixture();
  const corruptArchive = Buffer.from("invalid zstd stream");
  await writeFile(paths.compressed, corruptArchive);
  const build = JSON.parse(await readFile(paths.buildEvidence, "utf8"));
  build.artifacts[0].sha256 = sha256(corruptArchive);
  build.artifacts[0].size = corruptArchive.length;
  await writeFile(paths.buildEvidence, JSON.stringify(build));
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /compressed image decompression failed/);
});

test("ARM64 and RISC-V promotion require a bound EDK2 firmware pair", async () => {
  for (const architecture of ["arm64", "riscv64"]) {
    const paths = await fixture(architecture);
    assert.equal(verify(paths).status, 0);
    const document = JSON.parse(await readFile(paths.qemuEvidence, "utf8"));
    delete document.inputs.firmwareVarsTemplate;
    await writeFile(paths.qemuEvidence, JSON.stringify(document));
    assert.match(verify(paths).stderr, /explicit pflash firmware pair/);
    document.firmwareMode = "bios";
    delete document.inputs.firmwareCode;
    document.inputs.bios = { sha256: "e".repeat(64) };
    await writeFile(paths.qemuEvidence, JSON.stringify(document));
    assert.match(
      verify(paths).stderr,
      /not a successful removable-USB qualification/,
    );
  }
});

test("promotion verifier rejects QEMU evidence for different expanded bytes", async () => {
  const paths = await fixture();
  await writeFile(paths.expanded, Buffer.alloc(4096, 8));
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /does not bind the exact expanded image/);
});

test("promotion verifier rejects persistence evidence for different expanded bytes", async () => {
  const paths = await fixture();
  const document = JSON.parse(
    await readFile(paths.persistenceEvidence, "utf8"),
  );
  document.virtualUsbReadback.sha256 = "c".repeat(64);
  await writeFile(paths.persistenceEvidence, JSON.stringify(document));
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /virtual USB readback/);
});

test("promotion requires clean guest shutdown after each persistence boot", async () => {
  const paths = await fixture();
  const original = JSON.parse(
    await readFile(paths.persistenceEvidence, "utf8"),
  );
  for (const index of [0, 1]) {
    for (const failure of [
      { terminationReason: "required-markers" },
      { success: false },
      { returnCode: -15 },
      { shutdownError: "QMP poweroff timed out" },
    ]) {
      const document = structuredClone(original);
      Object.assign(document.boots[index], failure);
      await writeFile(paths.persistenceEvidence, JSON.stringify(document));
      const result = verify(paths);
      assert.notEqual(result.status, 0, JSON.stringify({ index, failure }));
      assert.match(
        result.stderr,
        new RegExp(`persistence boot ${index + 1} evidence is invalid`),
      );
    }
  }
});

test("promotion verifier requires legacy BIOS evidence for x86_64", async () => {
  const paths = await fixture();
  paths.legacyBiosEvidence = undefined;
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--legacy-bios-evidence/);
});

test("promotion verifier rejects legacy BIOS evidence for different expanded bytes", async () => {
  const paths = await fixture();
  const document = JSON.parse(await readFile(paths.legacyBiosEvidence, "utf8"));
  document.inputs.image.sha256 = "f".repeat(64);
  await writeFile(paths.legacyBiosEvidence, JSON.stringify(document));
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /legacy BIOS evidence does not bind/);
});

test("promotion verifier rejects unversioned QEMU evidence", async () => {
  const paths = await fixture();
  const document = JSON.parse(await readFile(paths.qemuEvidence, "utf8"));
  delete document.emulator;
  await writeFile(paths.qemuEvidence, JSON.stringify(document));
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exact emulator path and version/);
});

test("promotion verifier rejects unbound QEMU firmware", async () => {
  const paths = await fixture();
  const document = JSON.parse(await readFile(paths.qemuEvidence, "utf8"));
  delete document.inputs.firmwareVarsTemplate;
  await writeFile(paths.qemuEvidence, JSON.stringify(document));
  const result = verify(paths);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /explicit pflash firmware pair/);
});
