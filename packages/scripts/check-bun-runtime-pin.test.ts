/**
 * Covers the install-time Bun runtime-pin guard. Harness: real — the decision
 * matrix is pure, and the CLI cases spawn the actual checker; the lifecycle
 * cases perform real package-manager installs (bun and npm) in temporary
 * fixture packages. The two-binary cases additionally require an off-pin Bun
 * binary via ELIZA_PIN_TEST_ALT_BUN and are skipped with that reason when it
 * is not provided; the always-run cases keep the install boundary covered.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { decideBunRuntimePin } from "./check-bun-runtime-pin.ts";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const checkerPath = path.join(
  repoRoot,
  "packages/scripts/check-bun-runtime-pin.ts",
);
// The repository's live pin, so a version bump changes only the manifest.
const canonicalPin = JSON.parse(
  readFileSync(path.join(repoRoot, ".github/ci-bun-version.json"), "utf8"),
).version;
const altBun = process.env.ELIZA_PIN_TEST_ALT_BUN;

function spawnChecker(args, env = {}) {
  return spawnSync(process.execPath, [checkerPath, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
}

function writeShim(directory, target) {
  mkdirSync(directory, { recursive: true });
  const shim = path.join(directory, "bun");
  writeFileSync(shim, `#!/bin/sh\nexec "${target}" "$@"\n`);
  chmodSync(shim, 0o755);
  return directory;
}

/**
 * One real install in a temporary fixture package. `postinstallBody` decides
 * what the lifecycle runs; the fixture pin file can diverge from the live pin
 * to force a mismatch without editing the repository manifest.
 */
function runInstall({
  installer,
  pinVersion = canonicalPin,
  pathPrepend,
  postinstall,
}) {
  const fixture = mkdtempSync(path.join(os.tmpdir(), "bun-pin-guard-"));
  const pinFile = path.join(fixture, "pin.json");
  writeFileSync(
    pinFile,
    JSON.stringify({ $comment: "fixture pin", version: pinVersion }),
  );
  const postinstallMarker = path.join(fixture, "sentinel.marker");
  writeFileSync(
    path.join(fixture, "package.json"),
    JSON.stringify({
      name: "bun-pin-guard-fixture",
      version: "0.0.0",
      private: true,
      scripts: {
        postinstall: `${postinstall} --pin-file ${JSON.stringify(pinFile)} && printf ran > ${JSON.stringify(postinstallMarker)}`,
      },
    }),
  );
  try {
    const result = spawnSync(installer[0], [...installer.slice(1), "install"], {
      cwd: fixture,
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        ...(pathPrepend ? { PATH: `${pathPrepend}:${process.env.PATH}` } : {}),
      },
    });
    return {
      status: result.status,
      output: `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
      markerExists: existsSync(postinstallMarker),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

describe("decideBunRuntimePin", () => {
  it("accepts only the exact pinned release", () => {
    assert.deepEqual(
      decideBunRuntimePin(
        { role: "installer", source: "/opt/bun", version: "1.4.2" },
        "1.4.2",
      ),
      { ok: true },
    );
  });

  it("rejects a different release with both versions named", () => {
    const newerPatch = decideBunRuntimePin(
      { role: "installer", source: "/opt/bun", version: "1.4.10" },
      "1.4.2",
    );
    assert.equal(newerPatch.ok, false);
    assert.match(newerPatch.message, /installer pin check failed/u);
    assert.match(newerPatch.message, /Bun 1\.4\.10/u);
    assert.match(newerPatch.message, /repository pin 1\.4\.2/u);

    assert.equal(
      decideBunRuntimePin(
        { role: "installer", source: "/opt/bun", version: "1.4.2" },
        "1.4.20",
      ).ok,
      false,
    );
    assert.equal(
      decideBunRuntimePin(
        { role: "postinstall", source: "PATH bun", version: "1.5.0" },
        "1.4.2",
      ).ok,
      false,
    );
  });

  it("treats prerelease and build tags as part of the release identity", () => {
    assert.equal(
      decideBunRuntimePin(
        { role: "postinstall", source: "PATH bun", version: "1.4.2-canary.1" },
        "1.4.2",
      ).ok,
      false,
    );
    assert.equal(
      decideBunRuntimePin(
        { role: "postinstall", source: "PATH bun", version: "1.4.2" },
        "1.4.2+d1632b2",
      ).ok,
      false,
    );
  });

  it("fails closed on missing and non-Bun version reports", () => {
    const missing = decideBunRuntimePin(
      { role: "installer", source: "/opt/other", version: "" },
      "1.4.2",
    );
    assert.equal(missing.ok, false);
    assert.match(missing.message, /no Bun version could be read/u);

    const notBun = decideBunRuntimePin(
      { role: "installer", source: "/usr/lib/npm", version: "10.9.8 hmm" },
      "1.4.2",
    );
    assert.equal(notBun.ok, false);
    assert.match(notBun.message, /not a concrete Bun release/u);
  });

  it("fails closed on a malformed canonical manifest", () => {
    const malformed = decideBunRuntimePin(
      { role: "runtime", source: "the running Bun", version: "1.4.2" },
      "latest",
    );
    assert.equal(malformed.ok, false);
    assert.match(malformed.message, /concrete Bun semver pin/u);
  });
});

describe("check-bun-runtime-pin CLI (manual mode)", () => {
  // The lifecycle child of a test run has no npm_execpath; strict mode must
  // refuse to guess, and manual mode must disclose what it did not verify.
  const noLifecycleEnv = { npm_execpath: "" };

  it("passes under the pinned toolchain and discloses the manual scope", () => {
    const result = spawnChecker(["--no-installer-context"], noLifecycleEnv);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /running Bun /u);
    assert.match(result.stdout, /pinned /u);
    assert.match(result.stdout, /no installer runtime was verified/u);
  });

  it("fails against a divergent pin file", () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "bun-pin-manual-"));
    const pinFile = path.join(fixture, "pin.json");
    writeFileSync(pinFile, JSON.stringify({ version: "9.9.9" }));
    try {
      const result = spawnChecker(
        ["--no-installer-context", "--pin-file", pinFile],
        noLifecycleEnv,
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /runtime pin check failed/u);
      assert.match(result.stderr, /repository pin 9\.9\.9/u);
      assert.match(result.stderr, /bun\.sh\/install/u);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("check-bun-runtime-pin CLI (installer context)", () => {
  it("fails closed when no installer runtime can be established", () => {
    const result = spawnChecker([], { npm_execpath: "" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /installer pin check failed/u);
    assert.match(result.stderr, /npm_execpath/u);
    assert.match(result.stderr, /git checkout -- bun\.lock/u);
  });

  it("fails closed when the installer is not a Bun runtime", () => {
    const fake = mkdtempSync(path.join(os.tmpdir(), "bun-installer-fake-"));
    const installer = path.join(fake, "installer");
    writeFileSync(installer, "#!/bin/sh\necho 10.9.8\n");
    chmodSync(installer, 0o755);
    try {
      const result = spawnChecker([], { npm_execpath: installer });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /installer pin check failed/u);
      assert.match(result.stderr, /10\.9\.8/u);
    } finally {
      rmSync(fake, { recursive: true, force: true });
    }
  });
});

describe("root postinstall wiring", () => {
  it("runs the pin guard as the first postinstall link", () => {
    const manifest = JSON.parse(
      readFileSync(path.join(repoRoot, "package.json"), "utf8"),
    );
    const postinstall = manifest.scripts?.postinstall;
    assert.equal(
      postinstall?.startsWith(
        "bun packages/scripts/check-bun-runtime-pin.ts && ",
      ),
      true,
      `root postinstall must run check-bun-runtime-pin.ts first, got: ${postinstall}`,
    );
  });
});

describe("install lifecycle (real package managers)", () => {
  it("passes a real bun install when installer and PATH bun are the pinned release", () => {
    const shimDir = writeShim(
      mkdtempSync(path.join(os.tmpdir(), "bun-pin-shim-ok-")),
      process.execPath,
    );
    const result = runInstall({
      installer: [process.execPath],
      pathPrepend: shimDir,
      postinstall: `bun ${JSON.stringify(checkerPath)}`,
    });
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Bun runtime pin check passed/u);
    assert.equal(result.markerExists, true);
  });

  it("fails a real install performed by npm, which is not Bun", () => {
    const shimDir = writeShim(
      mkdtempSync(path.join(os.tmpdir(), "bun-pin-shim-npm-")),
      process.execPath,
    );
    const result = runInstall({
      installer: [
        "npm",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
        "--no-progress",
      ],
      pathPrepend: shimDir,
      postinstall: `bun ${JSON.stringify(checkerPath)}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /installer pin check failed/u);
    assert.equal(result.markerExists, false);
  });

  it("refuses an off-pin installer even when PATH resolves the pinned bun", {
    skip: altBun
      ? false
      : "ELIZA_PIN_TEST_ALT_BUN (an off-pin Bun binary) is not set",
  }, () => {
    const altVersion = spawnSync(altBun, ["--version"], { encoding: "utf8" });
    assert.equal(altVersion.status, 0, altVersion.stderr);
    const shimDir = writeShim(
      mkdtempSync(path.join(os.tmpdir(), "bun-pin-shim-alt-parent-")),
      process.execPath,
    );
    const result = runInstall({
      installer: [altBun],
      pathPrepend: shimDir,
      postinstall: `bun ${JSON.stringify(checkerPath)}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /installer pin check failed/u);
    assert.match(
      result.output,
      new RegExp(`Bun ${altVersion.stdout.trim().replaceAll(".", "\\.")}`, "u"),
    );
    assert.match(result.output, /git checkout -- bun\.lock/u);
    assert.equal(result.markerExists, false);
  });

  it("blames the PATH postinstall bun, not the installer, when only the child is off-pin", {
    skip: altBun
      ? false
      : "ELIZA_PIN_TEST_ALT_BUN (an off-pin Bun binary) is not set",
  }, () => {
    const shimDir = writeShim(
      mkdtempSync(path.join(os.tmpdir(), "bun-pin-shim-alt-child-")),
      altBun,
    );
    const result = runInstall({
      installer: [process.execPath],
      pathPrepend: shimDir,
      postinstall: `bun ${JSON.stringify(checkerPath)}`,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.output, /postinstall pin check failed/u);
    assert.doesNotMatch(result.output, /installer pin check failed/u);
    assert.match(result.output, /matches the pin/u);
    assert.equal(result.markerExists, false);
  });
});
