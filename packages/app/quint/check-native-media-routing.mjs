/** Actual native profile projection and plugin handler regression, never external inference. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const base = testOutputPath("quint-native-media-routing");
mkdirSync(base, { recursive: true });
const out = mkdtempSync(path.join(base, "run-"));
for (const [cwd, config, file, names] of [
  [
    "packages/app",
    "vitest.host.config.ts",
    "src/runtime/native-runtime-profile.test.ts",
    [
      "native runtime profiles the default native profile keeps embeddings and speech on the device",
      "native runtime profiles the explicit Cloud QA profile is distinct and carries no local models",
      "native runtime profiles unknown profiles fail closed",
      "native runtime profiles text routes use the bound Cloud models for every tier",
      "native runtime profiles routing preferences pin text and speech while keeping other owner choices",
      "native runtime profiles a declaration names exactly one canonical HTTPS Cloud API base",
      "applying a profile before boot writes canonical routing, drops a shadowing desktop key and keeps other routes",
      "applying a profile before boot the Cloud QA profile enables media registration through its service route",
      "applying a profile before boot Cloud to Direct to Cloud replaces the image route without changing owner data or speech",
      "applying a profile before boot Cloud and Direct boot projections round-trip through the canonical routing store",
      "applying a profile before boot an incomplete or foreign binding writes nothing",
      "process policy at resident boot a selected profile records missed scheduled occurrences",
      "process policy at resident boot a host without a profile keeps its behavior and an unknown one fails closed",
    ],
  ],
  [
    "plugins/plugin-elizacloud",
    "vitest.config.ts",
    "__tests__/image-native-funding.http.test.ts",
    [
      "native image funding retains one operation across retries and preserves prepaid and failure boundaries",
    ],
  ],
]) {
  const report = path.join(out, `${path.basename(cwd)}.json`);
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "packages/scripts/run-vitest.ts"),
      "run",
      "--config",
      config,
      "--no-file-parallelism",
      file,
      "--reporter=json",
      `--outputFile=${report}`,
    ],
    {
      cwd: path.join(root, cwd),
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        NODE_OPTIONS:
          `${process.env.NODE_OPTIONS ?? ""} --conditions=eliza-source --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
      },
    },
  );
  writeFileSync(
    path.join(out, `${path.basename(cwd)}.log`),
    `${result.stdout ?? ""}\n${result.stderr ?? ""}`,
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  requireVitestConformance(
    JSON.parse(readFileSync(report, "utf8")),
    path.join(root, cwd, file),
    names,
  );
}
const native = spawnSync(
  process.execPath,
  [
    "--test",
    "--test-reporter=tap",
    "plugins/plugin-native-agent/test/provider-admission/provider-admission.node.mjs",
    "plugins/plugin-native-agent/test/connection/connection.node.mjs",
  ],
  {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  },
);
const nativeOutput = `${native.stdout ?? ""}\n${native.stderr ?? ""}`;
writeFileSync(path.join(out, "native-jvm.tap"), nativeOutput);
if (native.error) throw native.error;
assert.equal(
  native.signal,
  null,
  "Native provider conformance was interrupted",
);
assert.equal(native.status, 0, nativeOutput);
for (const name of [
  "native provider admission preserves account, expiry, generation and rollback behavior",
  "connection and resident lifecycle JVM contracts pass",
  "device billing routes exist in the Cloud API and exclude sign-in",
]) {
  assert.match(
    nativeOutput,
    new RegExp(`^ok \\d+ - ${RegExp.escape(name)}$`, "m"),
  );
}
assert.match(nativeOutput, /^# tests 3$/m);
assert.match(nativeOutput, /^# pass 3$/m);
assert.match(nativeOutput, /^# fail 0$/m);
assert.match(nativeOutput, /^# skipped 0$/m);
console.log(
  "NativeMediaRouting conformance passed TS profile, JVM model env binding and SDK HTTP",
);
