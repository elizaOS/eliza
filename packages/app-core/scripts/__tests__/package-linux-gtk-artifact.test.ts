/**
 * Contract tests for the Linux GTK/WebKit desktop artifact producer and
 * verifier. The harness is real: it stages fake shell binaries on disk,
 * produces genuine tar.zst archives via the system tar, signs with real
 * Ed25519 keys, and asserts that tampering with any byte of the archive or
 * manifest is rejected. Archive-side regressions re-sign deliberately
 * wrong-type, wrong-mode, and symlinked entrypoints with the genuine key, so a
 * verifier that trusted digests and member names alone would fail here. The
 * vendored manifest schema is pinned by digest and the validator is generated
 * from those bytes, so cross-repository drift is caught here rather than in
 * the OS image.
 */

import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
  writeSync,
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
  signBytes,
  VENDORED_SCHEMA_SHA256,
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

  it("never deletes a replacement installed during a failed publication", () => {
    const outDir = tempDir();
    const replacement = Buffer.from("replacement owned by another writer");
    const archiveName = "eliza-desktop-gtk-1.2.3-x86_64.tar.zst";
    const signatureName = "eliza-desktop-gtk-1.2.3-x86_64.sig";
    const { privateKeyPem } = generateSigningKeyPair();
    expect(() =>
      produceArtifact({
        stageDir: stageShell(),
        outDir,
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
        testHooks: {
          afterPublishEntry: ({ index, publishedPath }) => {
            if (index !== 0) return;
            renameSync(publishedPath, path.join(outDir, "owned-archive"));
            writeFileSync(publishedPath, replacement, { flag: "wx" });
            writeFileSync(path.join(outDir, signatureName), "collision", {
              flag: "wx",
            });
          },
        },
      }),
    ).toThrow();
    expect(readFileSync(path.join(outDir, archiveName))).toEqual(replacement);
    expect(existsSync(path.join(outDir, MANIFEST_NAME))).toBe(false);
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

  it("never deletes a replacement installed during a keypair collision", () => {
    const outDir = tempDir();
    const privateKeyPath = path.join(outDir, "desktop-signing.key.pem");
    const publicKeyPath = path.join(outDir, "desktop-signing.pub.pem");
    expect(() =>
      writeSigningKeyPair(outDir, {
        beforePublicKeyWrite: () => {
          renameSync(privateKeyPath, path.join(outDir, "owned-private.pem"));
          writeFileSync(privateKeyPath, "replacement private key", {
            flag: "wx",
          });
          writeFileSync(publicKeyPath, "collision", { flag: "wx" });
        },
      }),
    ).toThrow();
    expect(readFileSync(privateKeyPath, "utf8")).toBe(
      "replacement private key",
    );
    expect(readFileSync(publicKeyPath, "utf8")).toBe("collision");
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

  it("rejects an archive pathname replacement after cryptographic inspection", () => {
    const { result, outDir, publicKeyPem } = produce("x86_64");
    const originalArchive = path.join(tempDir(), "original.tar.zst");
    expect(() =>
      verifyArtifactDir(outDir, publicKeyPem, {
        beforeFinalStableFileCheck: ({ archivePath }) => {
          renameSync(archivePath, originalArchive);
          writeFileSync(archivePath, "replacement archive", { flag: "wx" });
        },
      }),
    ).toThrow(/archive .* changed during verification/);
    expect(readFileSync(result.archivePath, "utf8")).toBe(
      "replacement archive",
    );
  });

  it("rejects in-place contract mutation after archive inspection", () => {
    const { outDir, publicKeyPem } = produce("x86_64");
    const manifestPath = path.join(outDir, MANIFEST_NAME);
    expect(() =>
      verifyArtifactDir(outDir, publicKeyPem, {
        beforeFinalStableFileCheck: () => {
          writeFileSync(manifestPath, "{}\n");
        },
      }),
    ).toThrow(/manifest.*changed during verification/);
  });
});

describe("archive inspection is independent of $TMPDIR", () => {
  function withTmpDir<T>(value: string, run: () => T): T {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = value;
    try {
      return run();
    } finally {
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  }

  it("verifies a good artifact when $TMPDIR is unusable", () => {
    const { outDir, publicKeyPem } = produce("x86_64");
    const unusable = path.join(tempDir(), "no-such-temp-directory");
    expect(existsSync(unusable)).toBe(false);
    const manifest = withTmpDir(unusable, () =>
      verifyArtifactDir(outDir, publicKeyPem),
    );
    expect(manifest.archive).toBe("eliza-desktop-gtk-1.2.3-x86_64.tar.zst");
    expect(existsSync(unusable)).toBe(false);
  });

  // On macOS, bsdtar itself uses $TMPDIR for extended-attribute scratch and
  // prints a cosmetic "Could not open extended attribute file" warning here.
  // It is tar's own behaviour on both arms, not the module's.
  it("produces a verifiable artifact when $TMPDIR is unusable", () => {
    const { privateKeyPem, publicKeyPem } = generateSigningKeyPair();
    const outDir = tempDir();
    const stageDir = stageShell();
    const unusable = path.join(tempDir(), "no-such-temp-directory");
    withTmpDir(unusable, () =>
      produceArtifact({
        stageDir,
        outDir,
        privateKeyPem,
        version: "1.2.3",
        architecture: "x86_64",
        sourceCommit: COMMIT,
      }),
    );
    expect(verifyArtifactDir(outDir, publicKeyPem).architecture).toBe("x86_64");
    expect(existsSync(unusable)).toBe(false);
  });
});

describe("stability check decides on content, not on metadata churn", () => {
  it("accepts a no-op chmod during verification", () => {
    const { result, outDir, publicKeyPem } = produce("x86_64");
    const before = readFileSync(result.archivePath);
    const manifest = verifyArtifactDir(outDir, publicKeyPem, {
      beforeFinalStableFileCheck: ({ archivePath }) => {
        chmodSync(archivePath, statSync(archivePath).mode & 0o7777);
      },
    });
    expect(manifest.archive).toBe("eliza-desktop-gtk-1.2.3-x86_64.tar.zst");
    expect(readFileSync(result.archivePath).equals(before)).toBe(true);
  });

  it("accepts an extra hard link, as a release mirror creates", () => {
    const { result, outDir, publicKeyPem } = produce("x86_64");
    const before = readFileSync(result.archivePath);
    const mirror = path.join(tempDir(), "mirrored.tar.zst");
    const manifest = verifyArtifactDir(outDir, publicKeyPem, {
      beforeFinalStableFileCheck: ({ archivePath }) => {
        linkSync(archivePath, mirror);
      },
    });
    expect(manifest.archive).toBe("eliza-desktop-gtk-1.2.3-x86_64.tar.zst");
    expect(statSync(result.archivePath).nlink).toBe(2);
    expect(readFileSync(result.archivePath).equals(before)).toBe(true);
  });

  it("still rejects a same-size rewrite whose mtime was restored", () => {
    const { result, outDir, publicKeyPem } = produce("x86_64");
    const original = readFileSync(result.archivePath);
    // Pin the timestamps to a value utimes can restore exactly, so the rewrite
    // below leaves size and mtime identical and only the change time moves.
    const FORGED_SECONDS = 1_700_000_000;
    utimesSync(result.archivePath, FORGED_SECONDS, FORGED_SECONDS);
    const originalMtimeMs = statSync(result.archivePath).mtimeMs;
    expect(() =>
      verifyArtifactDir(outDir, publicKeyPem, {
        beforeFinalStableFileCheck: ({ archivePath }) => {
          const fd = openSync(archivePath, "r+");
          try {
            writeSync(fd, Buffer.from([original[0] ^ 0xff]), 0, 1, 0);
          } finally {
            closeSync(fd);
          }
          utimesSync(archivePath, FORGED_SECONDS, FORGED_SECONDS);
        },
      }),
    ).toThrow(/archive .* changed during verification/);
    const after = readFileSync(result.archivePath);
    expect(after.length).toBe(original.length);
    expect(after.equals(original)).toBe(false);
    // The forged mtime is what makes this the one tampering case that size and
    // mtime cannot see: only the change time moved, and the re-read decided it.
    expect(statSync(result.archivePath).mtimeMs).toBe(originalMtimeMs);
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
        "schemaVersion must equal 1",
        'unknown field "unexpected"',
        'shell must equal "gtk-webkit"',
        "architecture must be one of x86_64, arm64, riscv64",
        "archive must match /^[A-Za-z0-9._-]+\\.tar\\.zst$/",
        "entrypoints.desktop must match /^bin/[A-Za-z0-9._-]+$/",
        'missing required field "entrypoints.doctor"',
        'unknown field "entrypoints.extra"',
        "capabilities.tray must equal true",
        'missing required field "capabilities.overlay"',
      ]),
    );
  });

  it("keeps the vendored schema aligned with the validator", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    expect(schema.properties.architecture.enum).toEqual(ARCHITECTURES);
    expect(schema.properties.manifestSignature.const).toBe(
      MANIFEST_SIGNATURE_NAME,
    );
  });

  it("validates every schema-declared field, not a hand-picked subset", () => {
    const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));
    const walk = (node: Record<string, unknown>, prefix: string): string[] =>
      ((node.required as string[]) ?? []).flatMap((key) => {
        const child = (node.properties as Record<string, never>)[key] as
          | Record<string, unknown>
          | undefined;
        const here = prefix ? `${prefix}.${key}` : key;
        return [here, ...(child?.type === "object" ? walk(child, here) : [])];
      });
    const allRequired = walk(schema, "");
    expect(allRequired.length).toBe(20);
    const { outDir } = produce("x86_64");
    const pristine = readFileSync(path.join(outDir, MANIFEST_NAME), "utf8");
    for (const dotted of allRequired) {
      const manifest = JSON.parse(pristine);
      const parts = dotted.split(".");
      let cursor = manifest;
      for (const part of parts.slice(0, -1)) cursor = cursor[part];
      delete cursor[parts[parts.length - 1]];
      expect(manifestViolations(manifest)).toContain(
        `missing required field "${dotted}"`,
      );
    }
  });

  it("pins the vendored OS schema bytes and fails on any drift", () => {
    const bytes = readFileSync(SCHEMA_PATH);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      VENDORED_SCHEMA_SHA256,
    );
    // Even a semantically neutral edit is drift the pin must reject.
    const drifted = Buffer.concat([bytes, Buffer.from("\n")]);
    expect(createHash("sha256").update(drifted).digest("hex")).not.toBe(
      VENDORED_SCHEMA_SHA256,
    );
  });
});

/** Replaces the archive in `outDir` and re-signs everything with the real key. */
function resignWithArchiveFrom(
  outDir: string,
  stage: string,
  privateKeyPem: string,
): void {
  const manifestPath = path.join(outDir, MANIFEST_NAME);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const archivePath = path.join(outDir, manifest.archive);
  unlinkSync(archivePath);
  execFileSync("tar", ["--zstd", "-cf", archivePath, "-C", stage, "."]);
  const archiveBytes = readFileSync(archivePath);
  manifest.sha256 = createHash("sha256").update(archiveBytes).digest("hex");
  writeFileSync(
    path.join(outDir, manifest.signature),
    signBytes(privateKeyPem, archiveBytes),
  );
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(manifestPath, manifestBytes);
  writeFileSync(
    path.join(outDir, MANIFEST_SIGNATURE_NAME),
    signBytes(privateKeyPem, manifestBytes),
  );
}

describe("signed archives with an off-contract entrypoint", () => {
  it("rejects an entrypoint that is not executable in the archive", () => {
    const { outDir, publicKeyPem, privateKeyPem } = produce("x86_64");
    const rogue = stageShell();
    chmodSync(path.join(rogue, "bin", "eliza-agent"), 0o644);
    resignWithArchiveFrom(outDir, rogue, privateKeyPem);
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      /not executable in the archive/,
    );
  });

  it("rejects an entrypoint that is a directory in the archive", () => {
    const { outDir, publicKeyPem, privateKeyPem } = produce("arm64");
    const rogue = stageShell();
    const entry = path.join(rogue, "bin", "eliza-desktop");
    unlinkSync(entry);
    mkdirSync(entry);
    resignWithArchiveFrom(outDir, rogue, privateKeyPem);
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      /is not a regular archive file/,
    );
  });

  it("rejects an entrypoint that is an absolute symlink in the archive", () => {
    const { outDir, publicKeyPem, privateKeyPem } = produce("riscv64");
    const rogue = stageShell();
    const entry = path.join(rogue, "bin", "eliza-desktop");
    unlinkSync(entry);
    symlinkSync("/bin/true", entry);
    resignWithArchiveFrom(outDir, rogue, privateKeyPem);
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      ArtifactContractError,
    );
  });

  it("rejects an entrypoint that is a relative in-tree symlink", () => {
    const { outDir, publicKeyPem, privateKeyPem } = produce("x86_64");
    const rogue = stageShell();
    mkdirSync(path.join(rogue, "libexec"), { recursive: true });
    const real = path.join(rogue, "libexec", "eliza-desktop.real");
    writeFileSync(real, "#!/bin/sh\necho real\n");
    chmodSync(real, 0o755);
    const entry = path.join(rogue, "bin", "eliza-desktop");
    unlinkSync(entry);
    symlinkSync("../libexec/eliza-desktop.real", entry);
    resignWithArchiveFrom(outDir, rogue, privateKeyPem);
    // Rejected as an unsafe traversing link target before the entrypoint
    // check; either refusal is the contract, a verified symlink is not.
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      ArtifactContractError,
    );
  });

  it("rejects an entrypoint whose archive symlink dangles", () => {
    const { outDir, publicKeyPem, privateKeyPem } = produce("arm64");
    const rogue = stageShell();
    const entry = path.join(rogue, "bin", "eliza-desktop");
    unlinkSync(entry);
    symlinkSync("./gone", entry);
    resignWithArchiveFrom(outDir, rogue, privateKeyPem);
    expect(() => verifyArtifactDir(outDir, publicKeyPem)).toThrow(
      /is not a regular archive file/,
    );
  });
});
