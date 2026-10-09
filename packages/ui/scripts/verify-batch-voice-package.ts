/** Build and pack the real public entries; resolve an external consumer without source aliases. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const repo = path.resolve(import.meta.dirname, "../../.."),
  output = testOutputPath("batch-voice-package");
mkdirSync(output, { recursive: true });
const run = (command: string, args: string[], cwd = repo) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
for (const owner of ["core", "voice", "ui"])
  process.stdout.write(
    run("bun", ["run", "--cwd", `packages/${owner}`, "build"]),
  );
const consumer = mkdtempSync(path.join(output, "consumer-"));
try {
  for (const [owner, entry] of [
    ["core", "speech"],
    ["voice", "turn"],
    ["ui", "voice/batch-conversation"],
  ]) {
    const sourceRoot = path.join(repo, "packages", owner),
      sourceManifest = JSON.parse(
        readFileSync(path.join(sourceRoot, "package.json"), "utf8"),
      ),
      packageRoot = path.join(
        sourceRoot,
        sourceManifest.publishConfig?.directory ?? ".",
      ),
      manifest = JSON.parse(
        readFileSync(path.join(packageRoot, "package.json"), "utf8"),
      );
    const packed = JSON.parse(
      run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", consumer],
        packageRoot,
      ),
    )[0];
    for (const extension of ["js", "d.ts"])
      assert(
        packed.files.some(
          (file: { path: string }) =>
            file.path ===
            `${owner === "ui" ? "" : "dist/"}${entry}.${extension}`,
        ),
        `${owner} public ${extension} missing from normal build`,
      );
    const destination = path.join(consumer, "node_modules", manifest.name);
    mkdirSync(destination, { recursive: true });
    run("tar", [
      "-xzf",
      path.join(consumer, packed.filename),
      "--strip-components=1",
      "-C",
      destination,
    ]);
  }
  writeFileSync(
    path.join(consumer, "package.json"),
    JSON.stringify({ type: "module" }),
  );
  writeFileSync(
    path.join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        types: [],
        skipLibCheck: false,
      },
      files: ["consumer.ts"],
    }),
  );
  for (const file of ["consumer.ts", "runtime.mjs"])
    copyFileSync(
      path.join(import.meta.dirname, "fixtures/batch-voice-package", file),
      path.join(consumer, file),
    );
  process.stdout.write(
    run(
      path.join(repo, "node_modules/.bin/tsc"),
      ["-p", "tsconfig.json"],
      consumer,
    ),
  );
  process.stdout.write(run(process.execPath, ["runtime.mjs"], consumer));
  const metafile = path.join(consumer, "browser-meta.json"),
    bundle = path.join(consumer, "browser.mjs");
  process.stdout.write(
    run(
      "bun",
      [
        "build",
        "runtime.mjs",
        "--target=browser",
        "--format=esm",
        `--outfile=${bundle}`,
        `--metafile=${metafile}`,
      ],
      consumer,
    ),
  );
  const metadata = JSON.parse(readFileSync(metafile, "utf8")),
    inputs = Object.keys(metadata.inputs);
  for (const input of inputs) {
    const resolved = path.resolve(consumer, input);
    assert(
      resolved === path.join(consumer, "runtime.mjs") ||
        resolved.startsWith(path.join(consumer, "node_modules") + path.sep),
      `Consumer escaped its packed modules: ${input}`,
    );
    assert(
      !/(?:core|ui)\/(?:dist\/)?(?:index|protocol)\.js$|\/auth\/|\/host\//.test(
        input,
      ),
      `Broad host entry leaked: ${input}`,
    );
  }
  assert(
    !/\b(?:process|Buffer|Bun)\.|\brequire\(|["']node:/.test(
      readFileSync(bundle, "utf8"),
    ),
    "Browser entry contains Node dependencies or polyfills",
  );
  process.stdout.write(
    run(
      process.execPath,
      [
        "--experimental-vm-modules",
        path.join(
          import.meta.dirname,
          "fixtures/batch-voice-package/browser-runtime.mjs",
        ),
        bundle,
      ],
      consumer,
    ),
  );
  writeFileSync(
    path.join(output, "receipt.json"),
    `${JSON.stringify(
      {
        normalBuilds: ["core", "voice", "ui"],
        packedConsumerTypes: true,
        packedRuntimeTurn: true,
        packedOwnerInputPause: true,
        packedExactReplyResume: true,
        browserTargetNoNodeRealmTurn: true,
        inputCount: inputs.length,
        inputs,
        noSourceAliases: true,
        noRealMediaOrProvider: true,
      },
      null,
      2,
    )}\n`,
  );
  console.log(
    "PASS: packed public voice entries, external types and matching turn; browser closure has no host root or Node polyfills.",
  );
} finally {
  rmSync(consumer, { recursive: true, force: true });
}
