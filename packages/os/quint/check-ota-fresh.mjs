/** Generate Quint traces and replay them through the real Go OTA trust engine. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-ota-fresh");
await mkdir(output, { recursive: true });
const traceDirectory = await mkdtemp(path.join(output, "traces-"));
const require = createRequire(import.meta.url);
const quintPackage = require.resolve("@informalsystems/quint/package.json");
const cli = path.join(path.dirname(quintPackage), "dist/src/cli.js");
const generate = spawnSync(
  process.execPath,
  [
    cli,
    "run",
    "packages/os/quint/OtaFreshAdmission.qnt",
    "--main=OtaFreshAdmission",
    "--backend=typescript",
    "--seed=20261107",
    "--max-samples=40",
    "--n-traces=40",
    "--max-steps=20",
    "--invariant=invariant",
    `--out-itf=${path.join(traceDirectory, "trace-{seq}.itf.json")}`,
    "--verbosity=0",
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (generate.error) throw generate.error;
if (generate.signal) process.kill(process.pid, generate.signal);
assert.equal(generate.status, 0, `${generate.stdout}\n${generate.stderr}`);
function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (!value || typeof value !== "object") return value;
  if ("#bigint" in value) {
    const integer = Number(value["#bigint"]);
    assert(Number.isSafeInteger(integer));
    return integer;
  }
  if ("#map" in value) {
    return Object.fromEntries(
      value["#map"].map(([key, entry]) => [decode(key), decode(entry)]),
    );
  }
  if ("#set" in value) return value["#set"].map(decode);
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, decode(entry)]),
  );
}
const files = (await readdir(traceDirectory)).filter((file) =>
  /^trace-\d+\.itf\.json$/.test(file),
);
assert.equal(files.length, 40);
const traces = [];
for (const file of files) {
  const trace = JSON.parse(
    await readFile(path.join(traceDirectory, file), "utf8"),
  );
  assert.equal(trace.vars.length, 1);
  assert.equal(trace.states.length, 21);
  traces.push(trace.states.map((state) => decode(state[trace.vars[0]])));
}
const vectors = path.join(traceDirectory, "vectors.json");
await writeFile(vectors, JSON.stringify(traces));
const check = spawnSync(
  "go",
  ["test", "-count=1", "-run", "^TestQuintFreshAdmission$", "-json", "."],
  {
    cwd: path.join(root, "packages/os/native/ota-trust"),
    env: {
      ...process.env,
      GOTOOLCHAIN: "go1.27.1",
      OTA_FRESH_QUINT_VECTORS: vectors,
    },
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  },
);
if (check.error) throw check.error;
await writeFile(
  path.join(output, "go-conformance.log"),
  `${check.stdout}\n${check.stderr}`,
);
process.stdout.write(check.stdout);
process.stderr.write(check.stderr);
if (check.signal) process.kill(process.pid, check.signal);
assert.equal(check.status, 0, "Real OTA admission diverged from Quint");
const events = check.stdout
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));
assert.equal(
  events.filter(
    (event) =>
      event.Action === "pass" && event.Test === "TestQuintFreshAdmission",
  ).length,
  1,
  "Go did not report the expected conformance test as passing",
);
assert(
  events.some((event) =>
    event.Output?.includes(
      "40 Quint traces, 800 real admission transitions, 0 differences",
    ),
  ),
  "Go did not confirm the expected number of replayed transitions",
);
await writeFile(
  path.join(output, "results.json"),
  `${JSON.stringify(
    {
      result: "passed",
      traces: traces.length,
      steps: traces.reduce((total, trace) => total + trace.length - 1, 0),
      seed: 20261107,
      backend: "Go 1.27.1 real OTA trust engine",
    },
    null,
    2,
  )}\n`,
);
