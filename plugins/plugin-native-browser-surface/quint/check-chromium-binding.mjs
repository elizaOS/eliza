/** Replays finite Quint traces through the production Java binding state owner. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model =
  "plugins/plugin-native-browser-surface/quint/ChromiumBindingDemand.qnt";
assert.equal(path.resolve(root, process.argv[2] ?? ""), path.join(root, model));
const outputRoot = testOutputPath("quint-chromium-binding");
await mkdir(outputRoot, { recursive: true });
const output = await mkdtemp(path.join(outputRoot, "run-"));
function run(binary, args, input) {
  const result = spawnSync(binary, args, {
    cwd: root,
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  return result.stdout;
}
const require = createRequire(import.meta.url);
const quint = path.join(
  path.dirname(require.resolve("@informalsystems/quint/package.json")),
  "dist/src/cli.js",
);
run(process.execPath, [
  quint,
  "run",
  model,
  "--backend=typescript",
  "--main=ChromiumBindingDemandTrace",
  "--seed=20261108",
  "--max-steps=40",
  "--max-samples=512",
  "--n-traces=512",
  "--invariant=invariant",
  `--out-itf=${path.join(output, "trace-{seq}.itf.json")}`,
  "--verbosity=0",
]);
const files = (await readdir(output))
  .filter((name) => /^trace-\d+\.itf\.json$/.test(name))
  .sort();
assert.equal(files.length, 512);
function decode(value) {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(decode);
  if ("#bigint" in value) return Number(value["#bigint"]);
  if ("#set" in value) return new Set(value["#set"].map(decode));
  if ("#map" in value)
    return new Map(value["#map"].map((pair) => pair.map(decode)));
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decode(entry)]),
  );
}
const mask = (values) => [...values].reduce((bits, id) => bits | (1 << id), 0);
const commands = [];
const expected = [];
const locations = [];
const operations = new Map();
for (const file of files) {
  const trace = JSON.parse(await readFile(path.join(output, file), "utf8"));
  assert.equal(trace.states.length, 41);
  for (const [index, raw] of trace.states.entries()) {
    const s = decode(
      raw["ChromiumBindingDemandTrace::ChromiumBindingDemand::s"],
    );
    const event = decode(
      raw["ChromiumBindingDemandTrace::ChromiumBindingDemand::event"],
    );
    commands.push(
      [event.name, event.id, event.result, event.effect].join("\t"),
    );
    expected.push(
      [
        s.pinned,
        s.leases,
        s.bound,
        s.ready,
        s.closed,
        mask(s.acquired),
        mask(s.open),
        mask(s.registered),
        mask(s.fired),
        s.waiting.join(","),
        s.effects.get(0),
        s.effects.get(1),
        s.retry,
        s.idle,
        s.backoff,
        s.verdict,
        s.unsafeCallback,
      ].join("\t"),
    );
    locations.push(`${file} state ${index}`);
    operations.set(event.name, (operations.get(event.name) ?? 0) + 1);
  }
}
for (const operation of [
  "init",
  "acquire",
  "pin",
  "unpin",
  "release",
  "register",
  "connect",
  "disconnect",
  "lost",
  "retry",
  "idle",
  "close",
]) {
  assert(operations.get(operation) > 0, `Missing trace operation ${operation}`);
}
const java = (name) =>
  process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, "bin", name) : name;
const classes = path.join(output, "classes");
await mkdir(classes);
const plugin = "plugins/plugin-native-browser-surface";
run(java("javac"), [
  "-J-Xmx128m",
  "-d",
  classes,
  `${plugin}/android/src/main/java/ai/eliza/plugins/browsersurface/ChromiumBindingDemand.java`,
  `${plugin}/quint/ChromiumBindingDemandReplay.java`,
  `${plugin}/test/native-host/ChromiumBindingDemandTest.java`,
]);
const input = `${commands.join("\n")}\n`;
await writeFile(path.join(output, "commands.tsv"), input);
const result = run(
  java("java"),
  ["-Xmx128m", "-cp", classes, "ChromiumBindingDemandReplay"],
  input,
);
await writeFile(path.join(output, "observed.tsv"), result);
const observed = result.trimEnd().split("\n");
assert.equal(observed.length, expected.length);
for (let index = 0; index < observed.length; index++) {
  assert.equal(
    observed[index],
    expected[index],
    `${locations[index]} ${commands[index]}`,
  );
}
const regression = run(java("java"), [
  "-Xmx128m",
  "-cp",
  classes,
  "ChromiumBindingDemandTest",
]);
assert.match(regression, /^\d+ assertions passed\n$/);
const summary = {
  passed: true,
  traces: files.length,
  states: expected.length,
  operations: Object.fromEntries(operations),
  regression: regression.trim(),
};
await writeFile(
  path.join(output, "summary.json"),
  `${JSON.stringify(summary, null, 2)}\n`,
);
console.log(
  `Chromium binding replay passed ${summary.traces} traces and ${summary.states} states. ${regression.trim()}. Results ${output}`,
);
