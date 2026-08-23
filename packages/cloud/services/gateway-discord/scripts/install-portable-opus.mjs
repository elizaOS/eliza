/**
 * Installs and attests the portable Discord Opus addon used by Linux images.
 * The amd64 and arm64 hashes are for the official v0.10.0 Node-v108/N-API-v3
 * musl release assets; other architectures retain the source-build path and
 * must still pass a real load/encode/decode check before an image can finish.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

export const OPUS_PACKAGE_VERSION = "0.10.0";
export const OPUS_PREBUILD_NODE_TARGET = "18.4.0";

export const OPUS_LINUX_MUSL_PREBUILDS = Object.freeze({
  arm64: Object.freeze({
    directory: "node-v108-napi-v3-linux-arm64-musl-1.2.5",
    sha256: "cb9194a8a785434918a42312d4d9f04167f7e316cf577f487c8e2ebfbdd12080",
  }),
  x64: Object.freeze({
    directory: "node-v108-napi-v3-linux-x64-musl-1.2.5",
    sha256: "d5396d0f6ba4f07851c8fa0f98183b19bb856c9bfbb150d02984ebb54a2140df",
  }),
});

function fail(message) {
  throw new Error(`[portable-opus] ${message}`);
}

function readManifest(packageRoot) {
  const path = join(packageRoot, "node_modules/@discordjs/opus/package.json");
  if (!existsSync(path)) fail(`missing installed manifest at ${path}`);
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  if (manifest.version !== OPUS_PACKAGE_VERSION) {
    fail(
      `expected @discordjs/opus ${OPUS_PACKAGE_VERSION}, found ${String(manifest.version)}`,
    );
  }
  return { manifest, path };
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function exerciseEncoder(OpusEncoder) {
  const encoder = new OpusEncoder(48_000, 2);
  const packet = encoder.encode(Buffer.alloc(3_840), 960);
  const decoded = encoder.decode(packet);
  if (packet.byteLength < 1 || decoded.byteLength !== 3_840) {
    fail(
      `encode/decode smoke test returned packetBytes=${packet.byteLength}, decodedBytes=${decoded.byteLength}`,
    );
  }
  return { packetBytes: packet.byteLength, decodedBytes: decoded.byteLength };
}

export function smokeTestOpus(packageRoot) {
  const require = createRequire(join(resolve(packageRoot), "package.json"));
  const { OpusEncoder } = require("@discordjs/opus");
  return exerciseEncoder(OpusEncoder);
}

export function smokeTestOpusBinary(binaryPath) {
  const require = createRequire(import.meta.url);
  const { OpusEncoder } = require(resolve(binaryPath));
  return exerciseEncoder(OpusEncoder);
}

export function verifyPortableOpusPackage({
  packageRoot,
  platform = process.platform,
  arch = process.arch,
  smokeTest = true,
}) {
  if (platform !== "linux") fail(`unsupported prebuild platform ${platform}`);
  const expected = OPUS_LINUX_MUSL_PREBUILDS[arch];
  if (!expected)
    fail(`no attested Linux musl prebuild for architecture ${arch}`);

  const opusRoot = join(resolve(packageRoot), "node_modules/@discordjs/opus");
  const { manifest, path: manifestPath } = readManifest(packageRoot);
  const prebuildRoot = join(opusRoot, "prebuild");
  if (!existsSync(prebuildRoot))
    fail(`missing prebuild directory at ${prebuildRoot}`);
  const builds = readdirSync(prebuildRoot).filter((entry) =>
    existsSync(join(prebuildRoot, entry, "opus.node")),
  );
  if (builds.length !== 1) {
    fail(`expected one installed Opus prebuild, found ${builds.length}`);
  }
  if (builds[0] !== expected.directory) {
    fail(`expected prebuild ${expected.directory}, found ${builds[0]}`);
  }

  const binaryPath = join(prebuildRoot, expected.directory, "opus.node");
  const actualHash = sha256(binaryPath);
  if (actualHash !== expected.sha256) {
    fail(
      `checksum mismatch for ${expected.directory}/opus.node: expected ${expected.sha256}, found ${actualHash}`,
    );
  }

  const modulePath = expected.directory.replace(
    "napi-v3",
    "napi-v{napi_build_version}",
  );
  if (!manifest.binary || typeof manifest.binary !== "object") {
    fail("installed manifest has no binary loader contract");
  }
  manifest.binary.module_path = `./prebuild/${modulePath}/`;
  writeFileSync(manifestPath, JSON.stringify(manifest));

  // Load the attested project copy directly here. A separate smoke-only call
  // runs in the final image to prove the package loader without Bun's install
  // cache being present.
  const proof = smokeTest ? smokeTestOpusBinary(binaryPath) : null;
  return { arch, binaryPath, sha256: actualHash, proof };
}

async function install() {
  const [workspaceRoot, packageRoot] = process.argv.slice(2);
  if (workspaceRoot === "--smoke-only") {
    if (!packageRoot) {
      fail("usage: install-portable-opus.mjs --smoke-only <package-root>");
    }
    const proof = smokeTestOpus(packageRoot);
    process.stdout.write(`[portable-opus] ${JSON.stringify({ proof })}\n`);
    return;
  }
  if (!workspaceRoot || !packageRoot) {
    fail("usage: install-portable-opus.mjs <workspace-root> <package-root>");
  }
  if (process.platform !== "linux") {
    fail(`container install requires Linux, found ${process.platform}`);
  }

  const prebuild = OPUS_LINUX_MUSL_PREBUILDS[process.arch];
  const env = { ...process.env };
  if (prebuild) {
    env.npm_config_target = OPUS_PREBUILD_NODE_TARGET;
  } else {
    delete env.npm_config_target;
  }
  // A copied tree is required in containers: Bun's cache-linked default makes
  // the JS loader resolve from /root/.bun while node-pre-gyp extracts the addon
  // into the project tree, and that cache is absent from the runtime stage.
  const child = Bun.spawn(
    ["bun", "install", "--production", "--backend=copyfile"],
    {
      cwd: resolve(workspaceRoot),
      env,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  const exitCode = await child.exited;
  if (exitCode !== 0) fail(`bun install exited with status ${exitCode}`);

  let proof;
  if (prebuild) {
    proof = verifyPortableOpusPackage({ packageRoot });
  } else {
    readManifest(packageRoot);
    proof = {
      arch: process.arch,
      sourceBuild: true,
      proof: smokeTestOpus(packageRoot),
    };
  }
  process.stdout.write(`[portable-opus] ${JSON.stringify(proof)}\n`);
}

if (import.meta.main) await install();
