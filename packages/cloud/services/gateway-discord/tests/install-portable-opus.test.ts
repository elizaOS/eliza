/**
 * Verifies the pinned portable Opus artifact contract with deterministic
 * filesystem fixtures; native loading remains proven by the image build.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OPUS_LINUX_MUSL_PREBUILDS,
  OPUS_PACKAGE_VERSION,
  OPUS_PREBUILD_NODE_TARGET,
  verifyPortableOpusPackage,
} from "../scripts/install-portable-opus.mjs";

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function fixtureFor(arch: "arm64" | "x64", version = OPUS_PACKAGE_VERSION) {
  const root = join(tmpdir(), `portable-opus-${crypto.randomUUID()}`);
  fixtures.push(root);
  const packageRoot = join(root, "service");
  const opusRoot = join(packageRoot, "node_modules/@discordjs/opus");
  const buildRoot = join(
    opusRoot,
    "prebuild",
    OPUS_LINUX_MUSL_PREBUILDS[arch].directory,
  );
  mkdirSync(buildRoot, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), '{"type":"module"}');
  writeFileSync(
    join(opusRoot, "package.json"),
    JSON.stringify({ version, binary: { module_path: "untrusted" } }),
  );
  writeFileSync(join(buildRoot, "opus.node"), "tampered-native-code");
  return packageRoot;
}

test("pins the Node target and official Linux musl addon hashes", () => {
  expect(OPUS_PREBUILD_NODE_TARGET).toBe("18.4.0");
  expect(OPUS_LINUX_MUSL_PREBUILDS).toEqual({
    arm64: {
      directory: "node-v108-napi-v3-linux-arm64-musl-1.2.5",
      sha256:
        "cb9194a8a785434918a42312d4d9f04167f7e316cf577f487c8e2ebfbdd12080",
    },
    x64: {
      directory: "node-v108-napi-v3-linux-x64-musl-1.2.5",
      sha256:
        "d5396d0f6ba4f07851c8fa0f98183b19bb856c9bfbb150d02984ebb54a2140df",
    },
  });
});

test("rejects a correctly named prebuild whose native bytes were replaced", () => {
  const packageRoot = fixtureFor("arm64");
  expect(() =>
    verifyPortableOpusPackage({
      packageRoot,
      platform: "linux",
      arch: "arm64",
      smokeTest: false,
    }),
  ).toThrow(/checksum mismatch/);
  const manifest = JSON.parse(
    readFileSync(
      join(packageRoot, "node_modules/@discordjs/opus/package.json"),
      "utf8",
    ),
  );
  expect(manifest.binary.module_path).toBe("untrusted");
});

test("rejects package-version and architecture drift before rewriting the loader", () => {
  expect(() =>
    verifyPortableOpusPackage({
      packageRoot: fixtureFor("x64", "0.10.1"),
      platform: "linux",
      arch: "x64",
      smokeTest: false,
    }),
  ).toThrow(/expected @discordjs\/opus 0\.10\.0/);
  expect(() =>
    verifyPortableOpusPackage({
      packageRoot: fixtureFor("x64"),
      platform: "linux",
      arch: "ppc64",
      smokeTest: false,
    }),
  ).toThrow(/no attested Linux musl prebuild/);
});

test("rejects ambiguous prebuild layouts instead of selecting one entry", () => {
  const packageRoot = fixtureFor("x64");
  const extraBuild = join(
    packageRoot,
    "node_modules/@discordjs/opus/prebuild/unattested/opus.node",
  );
  mkdirSync(join(extraBuild, ".."), { recursive: true });
  writeFileSync(extraBuild, "unattested-native-code");

  expect(() =>
    verifyPortableOpusPackage({
      packageRoot,
      platform: "linux",
      arch: "x64",
      smokeTest: false,
    }),
  ).toThrow(/expected one installed Opus prebuild, found 2/);
});
