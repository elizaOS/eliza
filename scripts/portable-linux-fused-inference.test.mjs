import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertDynamicDependencyClosure,
  assertRequiredRuntimeLibraries,
  buildPlan,
  compareNumericVersions,
  createBuilderWorkspace,
  createPrivateOutputStage,
  digestRegularTree,
  mmdebstrapArguments,
  PORTABLE_LINUX_FUSED_BUILD,
  PORTABLE_RUNTIME_LIBRARIES,
  parseArgs,
  parseElfDynamicSection,
  parseGlibcVersionInfo,
} from "./portable-linux-fused-inference.mjs";

const scriptPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "portable-linux-fused-inference.mjs",
);

test("immutable plan pins the proven Bookworm Vulkan portable build", () => {
  const plan = buildPlan({ jobs: 7, out: "/tmp/fused" });
  assert.equal(plan.mmdebstrap.mode, "unshare");
  assert.equal(plan.mmdebstrap.snapshot, "20250101T000000Z");
  assert.equal(plan.fork.commit, "6543d9078051a9bb194c2ef5c2995f003c5158de");
  assert.equal(
    plan.vulkanHeaders.commit,
    "e3b1eec08173d6b825cd3ac88c885a63b621504a",
  );
  assert.equal(plan.vulkanHeaders.tag, "v1.4.357");
  assert.equal(plan.backend, "vulkan");
  assert.equal(plan.cpuNative, false);
  assert.match(plan.abiAudit, /<= GLIBC_2\.38/);
  assert.ok(plan.mmdebstrap.packages.includes("glslc"));
  assert.ok(plan.mmdebstrap.packages.includes("libvulkan-dev"));
  assert.ok(plan.mmdebstrap.packages.includes("spirv-headers"));
  assert.ok(plan.mmdebstrap.packages.includes("mount"));
});

test("argument parsing rejects unsafe build parallelism and unknown flags", () => {
  assert.equal(parseArgs(["--jobs", "12", "--out", "/tmp/out"]).jobs, 12);
  assert.throws(() => parseArgs(["--jobs", "0"]), /1 through 64/);
  assert.throws(() => parseArgs(["--jobs", "2.5"]), /1 through 64/);
  assert.throws(() => parseArgs(["--surprise"]), /unknown argument/);
});

test("workspace is traversable by mmdebstrap while output staging stays private", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portable-modes-test-"));
  try {
    const workRoot = createBuilderWorkspace(root);
    const outputStage = createPrivateOutputStage(root);
    assert.equal(statSync(workRoot).mode & 0o777, 0o755);
    assert.equal(statSync(outputStage).mode & 0o777, 0o700);
    assert.match(path.basename(workRoot), /^eliza-portable-fused-/);
    assert.match(path.basename(outputStage), /^\.eliza-portable-fused-stage-/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("GNU libc parser is numeric and fail-closed for named ABI markers", () => {
  const parsed = parseGlibcVersionInfo(
    "Name: GLIBC_2.9 Name: GLIBC_2.38 Name: GLIBC_2.10 Name: GLIBC_PRIVATE",
  );
  assert.equal(parsed.maxVersion, "2.38");
  assert.deepEqual(parsed.versions, ["2.9", "2.10", "2.38"]);
  assert.deepEqual(parsed.unsupportedMarkers, ["GLIBC_PRIVATE"]);
  assert.equal(compareNumericVersions("2.43", "2.38"), 1);
  assert.equal(compareNumericVersions("2.9", "2.10"), -1);
});

test("complete runtime contract rejects a missing unversioned library", () => {
  const incomplete = PORTABLE_RUNTIME_LIBRARIES.filter(
    (library) => library !== "libllama-common.so",
  );
  assert.throws(
    () => assertRequiredRuntimeLibraries(incomplete),
    /omitted required output\(s\): libllama-common\.so/,
  );
});

test("complete runtime contract rejects a missing versioned SONAME library", () => {
  const incomplete = PORTABLE_RUNTIME_LIBRARIES.filter(
    (library) => library !== "libggml-vulkan.so.0",
  );
  assert.throws(
    () => assertRequiredRuntimeLibraries(incomplete),
    /omitted required output\(s\): libggml-vulkan\.so\.0/,
  );
});

test("dynamic dependency audit rejects an unresolved private library", () => {
  const dynamic = parseElfDynamicSection(`
 0x0000000000000001 (NEEDED) Shared library: [libomnivoice.so.0]
 0x0000000000000001 (NEEDED) Shared library: [libc.so.6]
 0x000000000000001d (RUNPATH) Library runpath: [$ORIGIN]
`);
  assert.throws(
    () =>
      assertDynamicDependencyClosure(
        [{ file: "libelizainference.so", ...dynamic }],
        PORTABLE_RUNTIME_LIBRARIES,
      ),
    /unresolved private DT_NEEDED dependency: libomnivoice\.so\.0/,
  );
});

test("dynamic dependency audit requires local lookup and known system libs", () => {
  assert.throws(
    () =>
      assertDynamicDependencyClosure(
        [
          {
            file: "libelizainference.so",
            needed: ["libllama.so.0"],
            searchPaths: [],
          },
        ],
        PORTABLE_RUNTIME_LIBRARIES,
      ),
    /no exact \$ORIGIN RUNPATH\/RPATH/,
  );
  assert.throws(
    () =>
      assertDynamicDependencyClosure(
        [
          {
            file: "libelizainference.so",
            needed: ["libsurprise-system.so.1"],
            searchPaths: ["$ORIGIN"],
          },
        ],
        PORTABLE_RUNTIME_LIBRARIES,
      ),
    /unapproved system DT_NEEDED dependency/,
  );
});

test("mmdebstrap command uses unprivileged hooks and temporary output", () => {
  const args = mmdebstrapArguments({
    hostStage: "/tmp/host-stage",
    jobs: 6,
    rootfs: "/tmp/rootfs",
    sourceBundle: "/tmp/source",
    vulkanDestination: "/tmp/Vulkan-Headers",
  });
  assert.ok(args.includes("--mode=unshare"));
  assert.ok(args.includes("--variant=buildd"));
  assert.ok(args.includes("--architectures=amd64"));
  assert.ok(
    args.some(
      (argument) =>
        argument.startsWith("--include=") &&
        argument.includes("spirv-headers") &&
        argument.includes("mount"),
    ),
  );
  assert.ok(
    args.some((argument) =>
      argument.includes("--variant vulkan --portable-cpu --jobs 6 --out /out"),
    ),
  );
  assert.ok(
    args.some((argument) =>
      argument.includes("sync-in '/tmp/Vulkan-Headers/include' /usr/include"),
    ),
  );
  assert.ok(
    args.some((argument) =>
      argument.includes("sync-out /out '/tmp/host-stage'"),
    ),
  );
  const gitTrustHooks = args.filter((argument) =>
    argument.includes("git config"),
  );
  assert.deepEqual(gitTrustHooks, [
    "--chrooted-customize-hook=git config --system --add safe.directory /work/plugins/plugin-local-inference/native/llama.cpp",
  ]);
  assert.ok(gitTrustHooks.every((argument) => !argument.includes("--global")));
  assert.ok(
    args.some(
      (argument) =>
        argument.includes("dpkg-query") &&
        argument.includes("spirv-headers") &&
        argument.includes("mount"),
    ),
  );
  assert.equal(args.at(-3), "bookworm");
  assert.equal(args.at(-2), "/tmp/rootfs");
  assert.match(args.at(-1), /snapshot\.debian\.org.*20250101T000000Z/);
});

test("regular-tree SHA-256 commits paths, modes, lengths, and bytes", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "portable-tree-test-"));
  try {
    mkdirSync(path.join(root, "vulkan"));
    writeFileSync(path.join(root, "vulkan", "a.h"), "alpha\n", { mode: 0o644 });
    writeFileSync(path.join(root, "vulkan", "b.h"), "beta\n", { mode: 0o644 });
    const first = digestRegularTree(root);
    const second = digestRegularTree(root);
    assert.equal(first.fileCount, 2);
    assert.equal(first.sha256, second.sha256);
    writeFileSync(path.join(root, "vulkan", "b.h"), "changed\n", {
      mode: 0o644,
    });
    assert.notEqual(digestRegularTree(root).sha256, first.sha256);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("print-plan performs no build and emits the public pinned contract", () => {
  const output = execFileSync(process.execPath, [scriptPath, "--print-plan"], {
    encoding: "utf8",
  });
  const plan = JSON.parse(output);
  assert.equal(plan.mmdebstrap.variant, "buildd");
  assert.equal(
    plan.vulkanHeaders.includeSha256,
    PORTABLE_LINUX_FUSED_BUILD.vulkanIncludeSha256,
  );
  assert.equal(plan.output, null);
});
