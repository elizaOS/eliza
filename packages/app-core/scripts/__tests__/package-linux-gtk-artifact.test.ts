/**
 * Contract tests for the Linux GTK/WebKit desktop artifact producer and
 * verifier. The harness is real: it stages fake shell binaries on disk,
 * produces genuine tar.zst archives via the system tar, signs with real
 * Ed25519 keys, and asserts that tampering with any byte of the archive or
 * manifest is rejected. It also pins the vendored manifest schema to the
 * fields the validator enforces so cross-repository drift is caught here.
 */

import { generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
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
  writeSigningKeyPair,
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

  it("refuses an entrypoint symlink even when its target is executable", () => {
    const stage = stageShell();
    const entrypoint = path.join(stage, "bin", "eliza-agent");
    rmSync(entrypoint);
    const external = path.join(tempDir(), "external-agent");
    writeFileSync(external, "#!/bin/sh\nexit 0\n");
    chmodSync(external, 0o755);
    symlinkSync(external, entrypoint);
    const { privateKeyPem } = generateSigningKeyPair();
    expect(() =>
      produceArtifact({
        stageDir: stage,
        outDir: tempDir(),
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/stage symlinks|regular non-symlink file/);
  });

  it("refuses an intermediate bin symlink and an escaping payload symlink", () => {
    const externalStage = stageShell();
    const stage = tempDir();
    symlinkSync(path.join(externalStage, "bin"), path.join(stage, "bin"));
    const { privateKeyPem } = generateSigningKeyPair();
    expect(() =>
      produceArtifact({
        stageDir: stage,
        outDir: tempDir(),
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/stage symlinks must use a non-traversing relative target/);

    const regularStage = stageShell();
    symlinkSync("/etc/passwd", path.join(regularStage, "share", "escape"));
    expect(() =>
      produceArtifact({
        stageDir: regularStage,
        outDir: tempDir(),
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/stage symlinks must use a non-traversing relative target/);
  });

  it("allows a non-traversing relative payload symlink", () => {
    const stage = stageShell();
    symlinkSync(
      "renderer.txt",
      path.join(stage, "share", "renderer-current.txt"),
    );
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const outDir = tempDir();
    produceArtifact({
      stageDir: stage,
      outDir,
      privateKeyPem,
      version: "1.2.3",
      architecture: "x86_64",
      sourceCommit: COMMIT,
    });
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).not.toThrow();
  });

  it("refuses recursive output and existing artifact outputs", () => {
    const stage = stageShell();
    const { privateKeyPem } = generateSigningKeyPair();
    expect(() =>
      produceArtifact({
        stageDir: stage,
        outDir: path.join(stage, "artifacts"),
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/must not be the stage directory/);

    const outDir = tempDir();
    const first = produceArtifact({
      stageDir: stage,
      outDir,
      privateKeyPem,
      version: "1.2.3",
      architecture: "x86_64",
      sourceCommit: COMMIT,
    });
    const originalArchive = readFileSync(first.archivePath);
    expect(() =>
      produceArtifact({
        stageDir: stage,
        outDir,
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/refusing to overwrite existing artifact output/);
    expect(readFileSync(first.archivePath)).toEqual(originalArchive);
  });

  it("refuses dangling output symlinks without creating their targets", () => {
    const stage = stageShell();
    const outDir = tempDir();
    const externalTarget = path.join(tempDir(), "external-manifest.json");
    symlinkSync(externalTarget, path.join(outDir, MANIFEST_NAME));
    const { privateKeyPem } = generateSigningKeyPair();
    expect(() =>
      produceArtifact({
        stageDir: stage,
        outDir,
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/refusing to overwrite existing artifact output/);
    expect(existsSync(externalTarget)).toBe(false);
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

  it("refuses a signing key from the wrong algorithm before emitting output", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const outDir = tempDir();
    expect(() =>
      produceArtifact({
        stageDir: stageShell(),
        outDir,
        privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(/signing key must be Ed25519/);
    expect(() => readFileSync(path.join(outDir, MANIFEST_NAME))).toThrow();
  });

  it("translates malformed key input to a typed contract failure", () => {
    const outDir = tempDir();
    expect(() =>
      produceArtifact({
        stageDir: stageShell(),
        outDir,
        privateKeyPem: "not a private key",
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    ).toThrow(ArtifactContractError);
    expect(() => readFileSync(path.join(outDir, MANIFEST_NAME))).toThrow();
  });
});

describe("writeSigningKeyPair", () => {
  it("creates a private key with mode 0600 and never overwrites it", () => {
    const outDir = tempDir();
    const { privateKeyPath } = writeSigningKeyPair(outDir);
    const originalPrivateKey = readFileSync(privateKeyPath);
    expect(statSync(privateKeyPath).mode & 0o777).toBe(0o600);
    expect(() => writeSigningKeyPair(outDir)).toThrow(
      /refusing to overwrite an existing desktop signing keypair/,
    );
    expect(readFileSync(privateKeyPath)).toEqual(originalPrivateKey);
  });

  it("rejects a public-key collision without leaving a half keypair", () => {
    const outDir = tempDir();
    const publicKeyPath = path.join(outDir, "desktop-signing.pub.pem");
    writeFileSync(publicKeyPath, "existing public key");
    expect(() => writeSigningKeyPair(outDir)).toThrow(/refusing to overwrite/);
    expect(existsSync(path.join(outDir, "desktop-signing.key.pem"))).toBe(
      false,
    );
    expect(readFileSync(publicKeyPath, "utf8")).toBe("existing public key");
  });

  it("rejects a dangling private-key symlink without creating its target", () => {
    const outDir = tempDir();
    const externalTarget = path.join(tempDir(), "external-private.pem");
    symlinkSync(externalTarget, path.join(outDir, "desktop-signing.key.pem"));
    expect(() => writeSigningKeyPair(outDir)).toThrow(/refusing to overwrite/);
    expect(existsSync(externalTarget)).toBe(false);
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

  it("rejects symlinked external contract files", () => {
    const { outDir, publicKeyPem } = produce("x86_64");
    const manifestPath = path.join(outDir, MANIFEST_NAME);
    const externalManifest = path.join(tempDir(), MANIFEST_NAME);
    renameSync(manifestPath, externalManifest);
    symlinkSync(externalManifest, manifestPath);
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      /regular non-symlink file/,
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
