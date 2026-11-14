/** Replay real existing launcher fixtures into the finite staging model. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const model = "packages/os/quint/LauncherNativeInstall.qnt";
const manifest = JSON.parse(
  readFileSync(path.join(root, model.replace(/\.qnt$/, ".cases.json")), "utf8"),
);
const inputs = [
  ...manifest.sources,
  model,
  model.replace(/\.qnt$/, ".cases.json"),
  "packages/os/quint/native-install-observation.mjs",
  "packages/os/quint/check-launcher-native.mjs",
];
const fingerprint = () =>
  Object.fromEntries(
    inputs.map((file) => [
      file,
      createHash("sha256")
        .update(readFileSync(path.join(root, file)))
        .digest("hex"),
    ]),
  );
const before = fingerprint();
const output = testOutputPath("quint-launcher-native");
mkdirSync(output, { recursive: true });
const directory = mkdtempSync(path.join(output, "run-"));
const testFiles = [
  "stage-launcher-overlay",
  "android-native-admission",
  "pixel10a-product",
].map((name) => `packages/os/scripts/__tests__/${name}.node.test.ts`);
const tests = spawnSync(
  process.execPath,
  [
    "packages/scripts/run-with-deadline.ts",
    "240000",
    "--",
    process.execPath,
    "--test",
    "--test-reporter=tap",
    ...testFiles,
  ],
  {
    cwd: root,
    env: { ...process.env, ELIZA_NATIVE_INSTALL_MODEL: "1" },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
writeFileSync(
  path.join(directory, "tests.log"),
  `${tests.stdout ?? ""}\n${tests.stderr ?? ""}`,
);
if (tests.error) throw tests.error;
assert.equal(tests.signal, null);
assert.equal(
  tests.status,
  0,
  `Existing staging suites failed: ${directory}/tests.log`,
);
assert.match(tests.stdout, /# fail 0\b/);
for (const name of [
  "Python source, pin, byte-integrity and packaging regressions",
  "reviewed privileged permissions move the Pixel 10a launcher and its JNI to priv-app, and nothing else does",
  "Soong conversion refuses changed APK, library or launcher definitions before replacing the Makefile",
  "Soong native installation uses the pinned source patch without ELF check overrides",
])
  assert.ok(
    tests.stdout.includes(`- ${name}\n`),
    `Missing completed fixture: ${name}`,
  );
const observations = [
  ...tests.stdout.matchAll(/^\s*# NATIVE_INSTALL_MODEL (.+)$/gm),
].map((match) => JSON.parse(Buffer.from(match[1], "base64").toString("utf8")));
const expected = [
  "compressed-refusal",
  "digest-refusal",
  "existing-output-refusal",
  "make-publication",
  "plain-make",
  "plain-soong",
  "privileged-make",
  "privileged-soong",
  "soong-publication",
  "system-soong",
];
assert.deepEqual(observations.map((row) => row.name).sort(), expected);
const traces = observations.map((row, index) => {
  let trace = `M::begin(${row.privileged}, ${row.soong}, ${row.valid ?? row.kind !== "refused"}, ${row.existing ?? false})`;
  if (row.kind === "refused") {
    trace += `.then(M::reject).expect(M::safety and M::s.output == ${row.output} and M::s.writes == 0)`;
  } else {
    const { report, blueprint, config } = row.result;
    const nativePrivileged = report.libraries.every((library) =>
      library.installPath.includes("/priv-app/"),
    );
    assert.deepEqual(
      report.libraries.map((library) => ({
        name: path.basename(library.path),
        sha256: library.sha256,
      })),
      row.source,
    );
    for (const library of report.libraries)
      assert.equal(
        library.installPath,
        `/${row.partition}/${row.privileged ? "priv-app" : "app"}/${report.moduleName}/lib/${row.arch}/${path.basename(library.path)}`,
      );
    assert.equal(
      (config.match(/user: AID_ROOT\ngroup: AID_ROOT\ncaps: 0/g) ?? []).length,
      report.libraries.length,
    );
    const imports = [
      ...blueprint.matchAll(/android_app_import \{([\s\S]*?)\n\}/g),
    ].map((match) => match[1]);
    const companions = row.soong ? imports.slice(1) : imports;
    const companionsPlain = companions.every(
      (block) => !block.includes("privileged: true"),
    );
    const patchRecorded = !!report.soongPatch;
    const qualified = !!(report.deployReady || report.runtimeAdmitted);
    trace += `.then(M::admit).then(M::render)`;
    if (row.kind === "published") trace += `.then(M::publish)`;
    trace += `.expect(M::safety and M::s.nativePrivileged == ${nativePrivileged} and M::s.patchRecorded == ${patchRecorded} and M::s.companionsPlain == ${companionsPlain} and M::s.qualified == ${qualified}`;
    if (row.kind === "published") trace += ` and M::s.output == ${row.output}`;
    trace += ")";
  }
  return `  run observed${index}Test = ${trace}`;
});
const wrapper = path.join(directory, "ObservedLauncherNative.qnt");
const modelImport = path
  .relative(directory, path.join(root, model))
  .replaceAll(path.sep, "/")
  .replace(/\.qnt$/, "");
writeFileSync(
  wrapper,
  `module ObservedLauncherNative {\n  import LauncherNativeInstall as M from ${JSON.stringify(modelImport)}\n${traces.join("\n")}\n}\n`,
);
const replay = spawnSync(
  process.execPath,
  [
    "node_modules/@informalsystems/quint/dist/src/cli.js",
    "test",
    wrapper,
    "--main=ObservedLauncherNative",
    "--backend=typescript",
    "--match=^observed[0-9]+Test$",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 4 * 1024 * 1024 },
);
writeFileSync(
  path.join(directory, "replay.log"),
  `${replay.stdout ?? ""}\n${replay.stderr ?? ""}`,
);
if (replay.error) throw replay.error;
assert.equal(replay.signal, null);
assert.equal(replay.status, 0, `Source replay failed: ${directory}/replay.log`);
assert.match(replay.stdout, new RegExp(`\\b${observations.length} passing`));
assert.deepEqual(fingerprint(), before, "Source changed during conformance");
writeFileSync(
  path.join(directory, "evidence.json"),
  `${JSON.stringify(
    {
      inputs: before,
      observations,
      scope:
        "Existing real launcher renderer/filesystem and Python admission suites. Controlled SDK inspection ports; no image boot or device qualification. Pinned Soong compilation is separate evidence.",
    },
    null,
    2,
  )}\n`,
);
console.log(
  `PASS launcher native source conformance: ${observations.length} observed fixture outcomes; ${directory}`,
);
