/**
 * Contract tests for the Linux GTK/WebKit desktop artifact producer and
 * verifier. The harness is real: it stages fake shell binaries on disk,
 * produces genuine tar.zst archives via the system tar, signs with real
 * Ed25519 keys, and asserts that tampering with any byte of the archive or
 * manifest is rejected. It also pins the vendored manifest schema to the
 * fields the validator enforces so cross-repository drift is caught here.
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ARCHITECTURES,
  ArtifactContractError,
  assertValidManifest,
  generateSigningKeyPair,
  listArchiveMembers,
  MANIFEST_NAME,
  MANIFEST_SIGNATURE_NAME,
  manifestViolations,
  produceArtifact,
  SCHEMA_PATH,
  verifyArtifactDir,
} from "../package-linux-gtk-artifact.mjs";

const tempDirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "linux-gtk-artifact-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const COMMIT = "a".repeat(40);

function stageShell(): string {
  const stage = tempDir();
  mkdirSync(path.join(stage, "bin"), { recursive: true });
  mkdirSync(path.join(stage, "share"), { recursive: true });
  for (const name of ["eliza-desktop", "eliza-agent", "eliza-desktop-doctor"]) {
    const file = path.join(stage, "bin", name);
    writeFileSync(file, `#!/bin/sh\necho ${name}\n`);
    chmodSync(file, 0o755);
  }
  writeFileSync(path.join(stage, "share", "renderer.txt"), "renderer payload");
  return stage;
}

function produce(
  architecture: string,
  overrides: Record<string, unknown> = {},
) {
  const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
  const outDir = tempDir();
  const result = produceArtifact({
    stageDir: stageShell(),
    outDir,
    privateKeyPem,
    version: "1.2.3",
    architecture,
    sourceCommit: COMMIT,
    ...overrides,
  });
  return { result, outDir, publicKeyPem, privateKeyPem };
}

describe("produceArtifact", () => {
  it("emits a verifiable artifact set for every supported architecture", () => {
    for (const architecture of ARCHITECTURES) {
      const { outDir, publicKeyPem } = produce(architecture);
      const manifest = verifyArtifactDir(outDir, publicKeyPem);
      expect(manifest.architecture).toBe(architecture);
      expect(manifest.shell).toBe("gtk-webkit");
      expect(manifest.archive).toBe(
        `eliza-desktop-gtk-1.2.3-${architecture}.tar.zst`,
      );
      expect(manifest.manifestSignature).toBe(MANIFEST_SIGNATURE_NAME);
    }
  });

  it("packages the staged tree with bin entrypoints as archive members", () => {
    const { result } = produce("x86_64");
    const members = listArchiveMembers(result.archivePath);
    expect(members).toContain("bin/eliza-desktop");
    expect(members).toContain("bin/eliza-agent");
    expect(members).toContain("bin/eliza-desktop-doctor");
    expect(members).toContain("share/renderer.txt");
  });

  it("refuses a stage with a missing entrypoint", () => {
    const stage = stageShell();
    rmSync(path.join(stage, "bin", "eliza-desktop-doctor"));
    const { privateKeyPem } = generateSigningKeyPair();
    expect(() =>
      produceArtifact({
        stageDir: stage,
        outDir: tempDir(),
        privateKeyPem,
        version: "1.2.3",
        architecture: "arm64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(ArtifactContractError);
  });

  it("refuses a non-executable entrypoint", () => {
    const stage = stageShell();
    chmodSync(path.join(stage, "bin", "eliza-agent"), 0o644);
    const { privateKeyPem } = generateSigningKeyPair();
    expect(() =>
      produceArtifact({
        stageDir: stage,
        outDir: tempDir(),
        privateKeyPem,
        version: "1.2.3",
        architecture: "riscv64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/not executable/);
  });

  it("refuses unsupported architectures and malformed versions", () => {
    expect(() => produce("amd64")).toThrow(/unsupported architecture/);
    expect(() => produce("x86_64", { version: "1.2" })).toThrow(
      /invalid version/,
    );
    expect(() => produce("x86_64", { sourceCommit: "deadbeef" })).toThrow(
      /invalid sourceCommit/,
    );
  });
});

describe("verifyArtifactDir", () => {
  it("rejects a tampered archive byte", () => {
    const { result, outDir, publicKeyPem } = produce("x86_64");
    const bytes = readFileSync(result.archivePath);
    bytes[bytes.length - 1] ^= 0xff;
    writeFileSync(result.archivePath, bytes);
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      /digest mismatch/,
    );
  });

  it("rejects a tampered manifest even when the digest still matches", () => {
    const { outDir, publicKeyPem } = produce("arm64");
    const manifestPath = path.join(outDir, MANIFEST_NAME);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.version = "9.9.9";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      /manifest signature does not verify/,
    );
  });

  it("rejects an archive signature made by a different key", () => {
    const { result, outDir, publicKeyPem } = produce("riscv64");
    const other = produce("riscv64");
    writeFileSync(
      result.archiveSignaturePath,
      readFileSync(other.result.archiveSignaturePath),
    );
    // Digest still matches the untouched archive; only the signature is wrong.
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      /archive signature does not verify/,
    );
  });

  it("rejects verification with the wrong public key", () => {
    const { outDir } = produce("x86_64");
    const stranger = generateSigningKeyPair();
    expect(() => verifyArtifactDir(outDir, stranger.publicKeyPem)).toThrow(
      /manifest signature does not verify/,
    );
  });
});

describe("manifest schema contract", () => {
  it("accepts a manifest that satisfies the vendored schema", () => {
    const { outDir } = produce("x86_64");
    const manifest = JSON.parse(
      readFileSync(path.join(outDir, MANIFEST_NAME), "utf8"),
    );
    expect(manifestViolations(manifest)).toEqual([]);
    expect(() => assertValidManifest(manifest)).not.toThrow();
  });

  it("flags every contract violation", () => {
    const bad = {
      schemaVersion: 2,
      sourceCommit: "nothex",
      version: "1.2",
      architecture: "amd64",
      shell: "electron",
      archive: "a.tar.gz",
      sha256: "short",
      signature: "sig.txt",
      manifestSignature: "other.sig",
      entrypoints: { desktop: "usr/bin/x", agent: "bin/ok", extra: "bin/y" },
      capabilities: { tray: false },
      unexpected: true,
    };
    const problems = manifestViolations(bad);
    expect(problems).toEqual(
      expect.arrayContaining([
        "schemaVersion must be 1",
        'unknown field "unexpected"',
        'shell must be "gtk-webkit"',
        "architecture must be one of x86_64, arm64, riscv64",
        "archive must be a bare *.tar.zst filename",
        "entrypoints.desktop must match bin/<name>",
        "entrypoints.doctor must match bin/<name>",
        'unknown entrypoint "extra"',
        "capabilities.tray must be true",
        "capabilities.overlay must be true",
      ]),
    );
  });

  it("keeps the vendored schema aligned with the validator", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    expect(schema.properties.architecture.enum).toEqual(ARCHITECTURES);
    expect(schema.properties.shell.const).toBe("gtk-webkit");
    expect(schema.properties.manifestSignature.const).toBe(
      MANIFEST_SIGNATURE_NAME,
    );
    expect(schema.required).toEqual([
      "schemaVersion",
      "sourceCommit",
      "version",
      "architecture",
      "shell",
      "archive",
      "sha256",
      "signature",
      "manifestSignature",
      "entrypoints",
      "capabilities",
    ]);
    expect(Object.keys(schema.properties.capabilities.properties)).toEqual([
      "tray",
      "overlay",
      "wayland",
      "cloudAuth",
      "computerUse",
      "remoteControl",
    ]);
  });
});
