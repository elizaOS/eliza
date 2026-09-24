import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
const architectures = ["x86_64", "arm64", "riscv64"];
// The signer requires canonical (realpath-stable) artifact roots by design;
// macOS places os.tmpdir() under the /var -> /private/var symlink, so anchor
// every fixture at the resolved real path.
const tmpRoot = realpathSync(os.tmpdir());

async function fixture() {
  const root = await mkdtemp(path.join(tmpRoot, "elizaos-image-signing-"));
  await mkdir(root, { recursive: true });
  for (const architecture of architectures) {
    const base = path.join(root, `elizaos-1.2.3-beta.4-${architecture}.raw`);
    await writeFile(base, `expanded-${architecture}-bytes\n`);
    await writeFile(`${base}.zst`, `zstd-${architecture}\n`);
  }
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyDer = publicKey.export({ format: "der", type: "spki" });
  return {
    root,
    manifest: path.join(root, "manifest.json"),
    privateKey: privateKey
      .export({ format: "der", type: "pkcs8" })
      .toString("base64"),
    publicKey: publicKeyDer.toString("base64"),
    publicKeyFingerprint: createHash("sha256")
      .update(publicKeyDer)
      .digest("hex"),
  };
}

async function signRelease(paths, overrides = {}) {
  const command = signReleaseCommand(paths, overrides);
  return execFileAsync(process.execPath, command.args, {
    cwd: repoRoot,
    env: command.env,
  });
}

function signReleaseCommand(paths, overrides = {}) {
  return {
    args: [
      "scripts/sign-image-release.ts",
      "--artifact-root",
      overrides.artifactRoot ?? paths.root,
      "--version",
      overrides.version ?? "1.2.3-beta.4",
      "--channel",
      overrides.channel ?? "beta",
      "--sequence",
      overrides.sequence ?? "42",
      "--expires",
      overrides.expires ?? "2099-01-01T00:00:00.000Z",
      "--base-url",
      overrides.baseUrl ??
        "https://download.elizaos.ai/os/releases/v1.2.3-beta.4/",
      "--output",
      overrides.output ?? paths.manifest,
    ],
    env: {
      ...process.env,
      SOURCE_DATE_EPOCH: "1700000000",
      ELIZAOS_RELEASE_ED25519_PRIVATE_KEY_PKCS8_BASE64: paths.privateKey,
      ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: paths.publicKey,
      ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256:
        paths.publicKeyFingerprint,
      ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S:
        paths.revokedKeyFingerprints ?? "",
      ...overrides.env,
    },
  };
}

function startSignRelease(paths, overrides = {}) {
  const command = signReleaseCommand(paths, overrides);
  const child = spawn(process.execPath, command.args, {
    cwd: repoRoot,
    env: command.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`signer exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, completion };
}

async function waitForPath(filePath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      await lstat(filePath);
      return;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function verifyReleaseCommand(paths, overrides = {}) {
  const args = [
    "scripts/verify-image-release.ts",
    "--manifest",
    paths.manifest,
    "--artifact-root",
    paths.root,
  ];
  if (overrides.requirePrivateRoot !== false)
    args.push("--require-private-root");
  if (overrides.publishRoot) args.push("--publish-root", overrides.publishRoot);
  return {
    args,
    env: {
      ...process.env,
      ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_BASE64: paths.publicKey,
      ELIZAOS_RELEASE_ED25519_PUBLIC_KEY_SPKI_SHA256:
        paths.publicKeyFingerprint,
      ELIZAOS_RELEASE_REVOKED_ED25519_PUBLIC_KEY_SPKI_SHA256S:
        paths.revokedKeyFingerprints ?? "",
      ...overrides.env,
    },
  };
}

async function verifyRelease(paths, overrides = {}) {
  const command = verifyReleaseCommand(paths, overrides);
  return execFileAsync(process.execPath, command.args, {
    cwd: repoRoot,
    env: command.env,
  });
}

function startVerifyRelease(paths, overrides = {}) {
  const command = verifyReleaseCommand(paths, overrides);
  const child = spawn(process.execPath, command.args, {
    cwd: repoRoot,
    env: command.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`verifier exited ${code ?? signal}: ${stderr}`));
    });
  });
  return { child, completion };
}

function artifactSignaturePath(paths, architecture) {
  return path.join(
    paths.root,
    `elizaos-1.2.3-beta.4-${architecture}.raw.zst.sig`,
  );
}

async function assertNoNewReleaseOutputs(paths, ignored = new Set()) {
  for (const filePath of [
    paths.manifest,
    `${paths.manifest}.sig`,
    ...architectures.map((architecture) =>
      artifactSignaturePath(paths, architecture),
    ),
  ]) {
    if (ignored.has(filePath)) continue;
    await assert.rejects(lstat(filePath), /ENOENT/);
  }
  assert.deepEqual(
    (await readdir(paths.root)).filter((name) => name.endsWith(".tmp")),
    [],
  );
  assert.deepEqual(
    (await readdir(paths.root)).filter((name) =>
      name.startsWith(".elizaos-release-stage-"),
    ),
    [],
  );
}

test("canonical image release signs and independently verifies exact bytes", async () => {
  const paths = await fixture();
  const first = await signRelease(paths);
  const manifestBytes = await readFile(paths.manifest);
  const manifestSignature = await readFile(`${paths.manifest}.sig`);
  const summary = JSON.parse(first.stdout);
  assert.equal(summary.publicKeySpkiBase64, paths.publicKey);
  assert.match(summary.publicKeyFingerprint, /^[a-f0-9]{64}$/);
  await verifyRelease(paths);

  await assert.rejects(
    signRelease(paths),
    /immutable release output already exists/,
  );

  const repeated = await fixture();
  repeated.privateKey = paths.privateKey;
  repeated.publicKey = paths.publicKey;
  repeated.publicKeyFingerprint = paths.publicKeyFingerprint;
  await signRelease(repeated);
  assert.deepEqual(await readFile(repeated.manifest), manifestBytes);
  assert.deepEqual(
    await readFile(`${repeated.manifest}.sig`),
    manifestSignature,
  );
});

test("public verification remains compatible with an observable extracted tree", async () => {
  const paths = await fixture();
  await signRelease(paths);
  await chmod(paths.root, 0o755);
  await verifyRelease(paths, { requirePrivateRoot: false });
});

test("private verification publishes only the exact held signed bytes", async () => {
  const paths = await fixture();
  await signRelease(paths);
  const parent = await mkdtemp(path.join(tmpRoot, "elizaos-publication-"));
  const publishRoot = path.join(parent, "publish");
  await verifyRelease(paths, { publishRoot });
  assert.deepEqual(
    await readFile(path.join(publishRoot, "metadata", "manifest.json")),
    await readFile(paths.manifest),
  );
  assert.deepEqual(
    await readFile(path.join(publishRoot, "metadata", "manifest.json.sig")),
    await readFile(`${paths.manifest}.sig`),
  );
  for (const architecture of architectures) {
    const basename = `elizaos-1.2.3-beta.4-${architecture}.raw.zst`;
    assert.deepEqual(
      await readFile(path.join(publishRoot, architecture, basename)),
      await readFile(path.join(paths.root, basename)),
    );
    assert.deepEqual(
      await readFile(path.join(publishRoot, architecture, `${basename}.sig`)),
      await readFile(path.join(paths.root, `${basename}.sig`)),
    );
  }
  await assert.rejects(verifyRelease(paths, { publishRoot }), /EEXIST/);
});

test("publication refuses a source pathname replacement after verification", async () => {
  const paths = await fixture();
  await signRelease(paths);
  const parent = await mkdtemp(path.join(tmpRoot, "elizaos-publication-"));
  const publishRoot = path.join(parent, "publish");
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-verify-hooks-"));
  const verification = startVerifyRelease(paths, {
    publishRoot,
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-publication-copy-0",
    },
  });
  await waitForPath(path.join(hooks, "before-publication-copy-0.ready"));
  await rename(paths.manifest, `${paths.manifest}.verified-original`);
  await writeFile(paths.manifest, "replacement-after-verification\n");
  await writeFile(
    path.join(hooks, "before-publication-copy-0.resume"),
    "resume\n",
  );
  await assert.rejects(
    verification.completion,
    /publication-input creation failed.*release file changed during verification/,
  );
  assert.equal(
    await readFile(paths.manifest, "utf8"),
    "replacement-after-verification\n",
  );
  await assert.rejects(
    lstat(path.join(publishRoot, "metadata", "manifest.json")),
    /ENOENT/,
  );
});

test("publication rejects an unsafe destination parent before creating output", async () => {
  const paths = await fixture();
  await signRelease(paths);
  const parent = await mkdtemp(path.join(tmpRoot, "elizaos-publication-"));
  await chmod(parent, 0o777);
  const publishRoot = path.join(parent, "publish");
  await assert.rejects(
    verifyRelease(paths, { publishRoot }),
    /publication root parent must be a canonical signer-owned non-writable directory/,
  );
  await assert.rejects(lstat(publishRoot), /ENOENT/);
});

test("publication refuses a replaced destination parent before copying", async () => {
  const paths = await fixture();
  await signRelease(paths);
  const parent = await mkdtemp(path.join(tmpRoot, "elizaos-publication-"));
  const displacedParent = `${parent}-displaced`;
  const publishRoot = path.join(parent, "publish");
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-verify-hooks-"));
  const verification = startVerifyRelease(paths, {
    publishRoot,
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-publication-copy-0",
    },
  });
  await waitForPath(path.join(hooks, "before-publication-copy-0.ready"));
  await rename(parent, displacedParent);
  await mkdir(parent, { mode: 0o700 });
  await writeFile(
    path.join(hooks, "before-publication-copy-0.resume"),
    "resume\n",
  );
  await assert.rejects(
    verification.completion,
    /publication-input creation failed.*publication directory changed/,
  );
  await assert.rejects(
    lstat(path.join(displacedParent, "publish", "metadata", "manifest.json")),
    /ENOENT/,
  );
});

test("SIGKILL during publication leaves an exclusive stale root", {
  timeout: 15_000,
}, async () => {
  const paths = await fixture();
  await signRelease(paths);
  const parent = await mkdtemp(path.join(tmpRoot, "elizaos-publication-"));
  const publishRoot = path.join(parent, "publish");
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-verify-hooks-"));
  const verification = startVerifyRelease(paths, {
    publishRoot,
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-publication-copy-0",
    },
  });
  await waitForPath(path.join(hooks, "before-publication-copy-0.ready"));
  verification.child.kill("SIGKILL");
  await assert.rejects(verification.completion, /SIGKILL/);
  await lstat(publishRoot);
  await assert.rejects(verifyRelease(paths, { publishRoot }), /EEXIST/);
  await assert.rejects(
    lstat(path.join(publishRoot, "metadata", "manifest.json")),
    /ENOENT/,
  );
});

test("SIGKILL after durable publication prerequisites leaves no manifest commit marker", {
  timeout: 15_000,
}, async () => {
  const paths = await fixture();
  await signRelease(paths);
  const parent = await mkdtemp(path.join(tmpRoot, "elizaos-publication-"));
  const publishRoot = path.join(parent, "publish");
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-verify-hooks-"));
  const verification = startVerifyRelease(paths, {
    publishRoot,
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-publication-manifest-commit",
    },
  });
  await waitForPath(
    path.join(hooks, "before-publication-manifest-commit.ready"),
  );
  verification.child.kill("SIGKILL");
  await assert.rejects(verification.completion, /SIGKILL/);
  for (const architecture of architectures) {
    const basename = `elizaos-1.2.3-beta.4-${architecture}.raw.zst`;
    await lstat(path.join(publishRoot, architecture, basename));
    await lstat(path.join(publishRoot, architecture, `${basename}.sig`));
  }
  await lstat(path.join(publishRoot, "metadata", "manifest.json.sig"));
  await assert.rejects(
    lstat(path.join(publishRoot, "metadata", "manifest.json")),
    /ENOENT/,
  );
  await assert.rejects(verifyRelease(paths, { publishRoot }), /EEXIST/);
});

test("source drift after publication manifest sync fails final verification", async () => {
  const paths = await fixture();
  await signRelease(paths);
  const parent = await mkdtemp(path.join(tmpRoot, "elizaos-publication-"));
  const publishRoot = path.join(parent, "publish");
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-verify-hooks-"));
  const verification = startVerifyRelease(paths, {
    publishRoot,
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "after-publication-manifest-sync",
    },
  });
  await waitForPath(path.join(hooks, "after-publication-manifest-sync.ready"));
  await writeFile(
    path.join(paths.root, "elizaos-1.2.3-beta.4-arm64.raw.zst"),
    "changed-after-publication-commit\n",
  );
  await writeFile(
    path.join(hooks, "after-publication-manifest-sync.resume"),
    "resume\n",
  );
  await assert.rejects(
    verification.completion,
    /publication-input creation failed.*release file changed during verification/,
  );
  await lstat(path.join(publishRoot, "metadata", "manifest.json"));
  await assert.rejects(
    verifyRelease(paths, { publishRoot }),
    /wrong-sized|byte binding/,
  );
});

test("canonical image verification rejects modified compressed bytes", async () => {
  const paths = await fixture();
  await signRelease(paths);
  await writeFile(
    path.join(paths.root, "elizaos-1.2.3-beta.4-arm64.raw.zst"),
    "tampered-but-nonempty\n",
  );
  await assert.rejects(verifyRelease(paths), /wrong-sized|byte binding/);
});

test("canonical image verification rejects an unknown public key fingerprint", async () => {
  const paths = await fixture();
  await signRelease(paths);
  const unknown = await fixture();
  paths.publicKeyFingerprint = unknown.publicKeyFingerprint;
  await assert.rejects(
    verifyRelease(paths),
    /does not match the independently pinned SPKI SHA-256/,
  );
});

test("canonical image verification requires an independent fingerprint pin", async () => {
  const paths = await fixture();
  await signRelease(paths);
  delete paths.publicKeyFingerprint;
  await assert.rejects(
    verifyRelease(paths),
    /PUBLIC_KEY_SPKI_SHA256 must be a nonzero lowercase SHA-256 digest/,
  );
});

test("canonical image verification rejects a revoked release key", async () => {
  const paths = await fixture();
  await signRelease(paths);
  paths.revokedKeyFingerprints = paths.publicKeyFingerprint;
  await assert.rejects(verifyRelease(paths), /verification key is revoked/);
});

test("signing refuses a stale private key after active-key rotation before writing output", async () => {
  const paths = await fixture();
  const rotated = await fixture();
  paths.publicKey = rotated.publicKey;
  paths.publicKeyFingerprint = rotated.publicKeyFingerprint;
  await assert.rejects(
    signRelease(paths, {
      artifactRoot: path.join(paths.root, "inaccessible"),
      channel: "invalid",
      output: path.join(paths.root, "inaccessible", "manifest.json"),
    }),
    /private key does not match the independently pinned active public key/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("signing refuses a revoked active key before writing output", async () => {
  const paths = await fixture();
  paths.revokedKeyFingerprints = paths.publicKeyFingerprint;
  await assert.rejects(
    signRelease(paths, {
      artifactRoot: path.join(paths.root, "inaccessible"),
      channel: "invalid",
      output: path.join(paths.root, "inaccessible", "manifest.json"),
    }),
    /verification key is revoked/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects linked output before writing or following the link", async () => {
  const paths = await fixture();
  const victim = path.join(paths.root, "must-not-be-overwritten");
  const linkedSignature = artifactSignaturePath(paths, architectures[0]);
  await writeFile(victim, "original-victim-bytes\n");
  await symlink(victim, linkedSignature);
  await assert.rejects(signRelease(paths), /output is linked/);
  assert.equal(await readFile(victim, "utf8"), "original-victim-bytes\n");
  assert.equal((await lstat(linkedSignature)).isSymbolicLink(), true);
  await assertNoNewReleaseOutputs(paths, new Set([linkedSignature]));
});

test("signing never follows a pre-created predictable temporary symlink", async () => {
  const paths = await fixture();
  const victim = path.join(paths.root, "temporary-link-victim");
  const legacyTemporary = `${artifactSignaturePath(paths, architectures[0])}.tmp`;
  await writeFile(victim, "original-victim-bytes\n");
  await symlink(victim, legacyTemporary);
  await signRelease(paths);
  assert.equal(await readFile(victim, "utf8"), "original-victim-bytes\n");
  assert.equal((await lstat(legacyTemporary)).isSymbolicLink(), true);
  assert.equal(
    (await readdir(paths.root)).some(
      (name) =>
        name.endsWith(".tmp") && name !== path.basename(legacyTemporary),
    ),
    false,
  );
  await verifyRelease(paths);
});

test("signing rejects an output path that aliases an image input", async () => {
  const paths = await fixture();
  const compressed = path.join(
    paths.root,
    "elizaos-1.2.3-beta.4-x86_64.raw.zst",
  );
  const original = await readFile(compressed);
  await assert.rejects(
    signRelease(paths, { output: compressed }),
    /output aliases an image input/,
  );
  assert.deepEqual(await readFile(compressed), original);
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects a hard-linked output alias without touching inputs", async () => {
  const paths = await fixture();
  const compressed = path.join(
    paths.root,
    "elizaos-1.2.3-beta.4-x86_64.raw.zst",
  );
  const original = await readFile(compressed);
  await link(compressed, paths.manifest);
  await assert.rejects(
    signRelease(paths),
    /output hard-links an image input|input is not a private nonempty regular file/,
  );
  assert.deepEqual(await readFile(compressed), original);
  assert.deepEqual(await readFile(paths.manifest), original);
  await assertNoNewReleaseOutputs(paths, new Set([paths.manifest]));
});

test("signing rejects an input writable by another security principal", async () => {
  const paths = await fixture();
  const input = path.join(paths.root, "elizaos-1.2.3-beta.4-x86_64.raw.zst");
  await chmod(input, 0o664);
  await assert.rejects(signRelease(paths), /input is not a private/);
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects manifest and artifact signature path aliases", async () => {
  const paths = await fixture();
  const signature = artifactSignaturePath(paths, architectures[0]);
  await assert.rejects(
    signRelease(paths, { output: signature }),
    /output paths alias each other/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects a symlinked artifact root", async () => {
  const paths = await fixture();
  const aliasParent = await mkdtemp(
    path.join(tmpRoot, "elizaos-image-signing-alias-"),
  );
  const alias = path.join(aliasParent, "artifact-root");
  await symlink(paths.root, alias);
  await assert.rejects(
    signRelease(paths, {
      artifactRoot: alias,
      output: path.join(alias, "manifest.json"),
    }),
    /artifact-root must be a signer-owned, non-symlink/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects an observable artifact root", async () => {
  const paths = await fixture();
  await chmod(paths.root, 0o750);
  await assert.rejects(
    signRelease(paths),
    /artifact-root must be an unpublished signer-owned mode-0700 directory/,
  );
  await assertNoNewReleaseOutputs(paths);
});

test("verification rejects a committed set made observable before promotion", async () => {
  const paths = await fixture();
  await signRelease(paths);
  await chmod(paths.root, 0o750);
  await assert.rejects(
    verifyRelease(paths),
    /artifact-root must remain an unpublished signer-owned mode-0700 directory/,
  );
});

test("signing rejects an input path replaced after its handle is opened", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "inputs-opened",
    },
  });
  await waitForPath(path.join(hooks, "inputs-opened.ready"));
  const input = path.join(paths.root, "elizaos-1.2.3-beta.4-arm64.raw.zst");
  const original = `${input}.opened-original`;
  await rename(input, original);
  await symlink(original, input);
  await writeFile(path.join(hooks, "inputs-opened.resume"), "resume\n");
  await assert.rejects(signing.completion, /input changed/);
  await assertNoNewReleaseOutputs(paths);
});

test("signing rejects an artifact root replaced after trusted handles are opened", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "inputs-opened",
    },
  });
  await waitForPath(path.join(hooks, "inputs-opened.ready"));
  const openedRoot = `${paths.root}.opened-original`;
  await rename(paths.root, openedRoot);
  await mkdir(paths.root, { mode: 0o700 });
  await writeFile(path.join(hooks, "inputs-opened.resume"), "resume\n");
  await assert.rejects(
    signing.completion,
    /artifact root or its parent changed/,
  );
  await assertNoNewReleaseOutputs(paths);
  await assertNoNewReleaseOutputs({
    ...paths,
    root: openedRoot,
    manifest: path.join(openedRoot, "manifest.json"),
  });
});

test("signing rejects a staged pathname substitution and leaves no residue", {
  timeout: 15_000,
}, async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "outputs-staged",
    },
  });
  await waitForPath(path.join(hooks, "outputs-staged.ready"));
  const stageName = (await readdir(paths.root)).find((name) =>
    name.startsWith(".elizaos-release-stage-"),
  );
  assert.ok(stageName);
  const staged = path.join(paths.root, stageName, "output-0");
  const displaced = path.join(paths.root, stageName, "displaced-output-0");
  await rename(staged, displaced);
  await symlink(displaced, staged);
  await writeFile(path.join(hooks, "outputs-staged.resume"), "resume\n");
  await assert.rejects(signing.completion, /staged release output changed/);
  await assertNoNewReleaseOutputs(paths);
});

test("signing does not overwrite an output raced into the release set", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "outputs-staged",
    },
  });
  await waitForPath(path.join(hooks, "outputs-staged.ready"));
  await writeFile(paths.manifest, "concurrent-publisher-bytes\n", {
    flag: "wx",
  });
  await writeFile(path.join(hooks, "outputs-staged.resume"), "resume\n");
  await assert.rejects(signing.completion, /output changed after preflight/);
  assert.equal(
    await readFile(paths.manifest, "utf8"),
    "concurrent-publisher-bytes\n",
  );
  await assertNoNewReleaseOutputs(paths, new Set([paths.manifest]));
});

test("active destination race preserves the raced file and cannot commit a manifest", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-output-publish-0",
    },
  });
  await waitForPath(path.join(hooks, "before-output-publish-0.ready"));
  const raced = artifactSignaturePath(paths, architectures[0]);
  await writeFile(raced, "concurrent-publisher-bytes\n", { flag: "wx" });
  await writeFile(
    path.join(hooks, "before-output-publish-0.resume"),
    "resume\n",
  );
  await assert.rejects(
    signing.completion,
    /unpublished release-set commit failed.*EEXIST/,
  );
  assert.equal(await readFile(raced, "utf8"), "concurrent-publisher-bytes\n");
  await assert.rejects(lstat(paths.manifest), /ENOENT/);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
});

test("late commit failure leaves no manifest and requires private-root recovery", async () => {
  const paths = await fixture();
  await assert.rejects(
    signRelease(paths, {
      env: {
        NODE_ENV: "test",
        ELIZAOS_RELEASE_TEST_FAIL_PROMOTION_AFTER: "4",
      },
    }),
    /unpublished release-set commit failed.*discard the private artifact root/,
  );
  await assert.rejects(lstat(paths.manifest), /ENOENT/);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
  assert.equal(
    (await readdir(paths.root)).filter((name) =>
      name.startsWith(".elizaos-release-stage-"),
    ).length,
    1,
  );
  await assert.rejects(
    signRelease(paths),
    /unfinished unpublished signing state requires operator recovery.*discard the private artifact root/,
  );
});

test("input drift before manifest commit leaves no verifier-visible release", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "outputs-promoted",
    },
  });
  await waitForPath(path.join(hooks, "outputs-promoted.ready"));
  const input = path.join(paths.root, "elizaos-1.2.3-beta.4-arm64.raw.zst");
  const inputBytes = await readFile(input);
  inputBytes[0] ^= 0xff;
  await writeFile(input, inputBytes);
  await writeFile(path.join(hooks, "outputs-promoted.resume"), "resume\n");
  await assert.rejects(
    signing.completion,
    /unpublished release-set commit failed.*input changed/,
  );
  await assert.rejects(lstat(paths.manifest), /ENOENT/);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
});

test("published signature drift before manifest commit cannot commit a release", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-manifest-commit",
    },
  });
  await waitForPath(path.join(hooks, "before-manifest-commit.ready"));
  const signaturePath = artifactSignaturePath(paths, architectures[0]);
  const signature = await readFile(signaturePath);
  signature[0] ^= 0xff;
  await chmod(signaturePath, 0o600);
  await writeFile(signaturePath, signature);
  await chmod(signaturePath, 0o400);
  await writeFile(
    path.join(hooks, "before-manifest-commit.resume"),
    "resume\n",
  );
  await assert.rejects(
    signing.completion,
    /unpublished release-set commit failed.*published release output changed/,
  );
  await assert.rejects(lstat(paths.manifest), /ENOENT/);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
});

test("input drift in the manifest commit gap leaves stale recovery state", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-manifest-commit",
    },
  });
  await waitForPath(path.join(hooks, "before-manifest-commit.ready"));
  const input = path.join(paths.root, "elizaos-1.2.3-beta.4-arm64.raw.zst");
  await writeFile(input, "changed-during-manifest-commit\n");
  await writeFile(
    path.join(hooks, "before-manifest-commit.resume"),
    "resume\n",
  );
  await assert.rejects(
    signing.completion,
    /unpublished release-set commit failed.*input changed/,
  );
  await lstat(paths.manifest);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
  await assert.rejects(
    signRelease(paths),
    /unfinished unpublished signing state requires operator recovery/,
  );
});

test("artifact-root drift after manifest sync prevents signer success", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "after-manifest-root-sync",
    },
  });
  await waitForPath(path.join(hooks, "after-manifest-root-sync.ready"));
  await chmod(paths.root, 0o750);
  await writeFile(
    path.join(hooks, "after-manifest-root-sync.resume"),
    "resume\n",
  );
  await assert.rejects(
    signing.completion,
    /unpublished release-set commit failed.*artifact root or its parent changed/,
  );
  await lstat(paths.manifest);
  await chmod(paths.root, 0o700);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
  await assert.rejects(
    signRelease(paths),
    /unfinished unpublished signing state requires operator recovery/,
  );
});

test("published-set drift after manifest sync prevents signer success", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "after-manifest-root-sync",
    },
  });
  await waitForPath(path.join(hooks, "after-manifest-root-sync.ready"));
  const signaturePath = artifactSignaturePath(paths, architectures[0]);
  const signature = await readFile(signaturePath);
  signature[0] ^= 0xff;
  await chmod(signaturePath, 0o600);
  await writeFile(signaturePath, signature);
  await chmod(signaturePath, 0o400);
  await writeFile(
    path.join(hooks, "after-manifest-root-sync.resume"),
    "resume\n",
  );
  await assert.rejects(
    signing.completion,
    /unpublished release-set commit failed.*published release output changed/,
  );
  await lstat(paths.manifest);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
  await assert.rejects(
    signRelease(paths),
    /unfinished unpublished signing state requires operator recovery/,
  );
});

test("SIGKILL before the manifest commit leaves explicit stale recovery state", {
  timeout: 15_000,
}, async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "before-manifest-commit",
    },
  });
  await waitForPath(path.join(hooks, "before-manifest-commit.ready"));
  signing.child.kill("SIGKILL");
  await assert.rejects(signing.completion, /SIGKILL/);
  await assert.rejects(lstat(paths.manifest), /ENOENT/);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
  await assert.rejects(
    signRelease(paths),
    /unfinished unpublished signing state requires operator recovery.*discard the private artifact root/,
  );
});

test("SIGKILL after manifest creation is not accepted until staging cleanup", {
  timeout: 15_000,
}, async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "after-manifest-commit",
    },
  });
  await waitForPath(path.join(hooks, "after-manifest-commit.ready"));
  signing.child.kill("SIGKILL");
  await assert.rejects(signing.completion, /SIGKILL/);
  await lstat(paths.manifest);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
  await assert.rejects(
    signRelease(paths),
    /unfinished unpublished signing state requires operator recovery/,
  );
});

test("input drift after manifest creation fails the signer's final validation", async () => {
  const paths = await fixture();
  const hooks = await mkdtemp(path.join(tmpRoot, "elizaos-sign-hooks-"));
  const signing = startSignRelease(paths, {
    env: {
      NODE_ENV: "test",
      ELIZAOS_RELEASE_TEST_HOOK_DIRECTORY: hooks,
      ELIZAOS_RELEASE_TEST_CHECKPOINT: "after-manifest-commit",
    },
  });
  await waitForPath(path.join(hooks, "after-manifest-commit.ready"));
  const input = path.join(paths.root, "elizaos-1.2.3-beta.4-arm64.raw.zst");
  await writeFile(input, "changed-after-manifest-creation\n");
  await writeFile(path.join(hooks, "after-manifest-commit.resume"), "resume\n");
  await assert.rejects(
    signing.completion,
    /unpublished release-set commit failed.*input changed/,
  );
  await lstat(paths.manifest);
  await assert.rejects(
    verifyRelease(paths),
    /verification refuses unfinished unpublished signing state/,
  );
});

test("canonical image signing rejects incomplete architecture sets", async () => {
  const paths = await fixture();
  await writeFile(
    path.join(paths.root, "elizaos-1.2.3-beta.4-riscv64.raw"),
    "",
  );
  await assert.rejects(signRelease(paths), /nonempty regular file/);
});
