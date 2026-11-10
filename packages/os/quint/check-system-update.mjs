import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const out = await mkdtemp(
  path.join(
    await mkdir(testOutputPath("system-update-journal"), {
      recursive: true,
    }).then(() => testOutputPath("system-update-journal")),
    "run-",
  ),
);
const require = createRequire(import.meta.url),
  cli = path.join(
    path.dirname(require.resolve("@informalsystems/quint/package.json")),
    "dist/src/cli.js",
  );
function run(command, args) {
  const r = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.equal(r.status, 0, r.stdout + "\n" + r.stderr);
  return r.stdout;
}
run(process.execPath, [
  cli,
  "run",
  "packages/os/quint/SystemUpdateJournal.qnt",
  "--main=SystemUpdateJournal",
  "--backend=typescript",
  "--seed=20261110",
  "--max-samples=50",
  "--n-traces=50",
  "--max-steps=16",
  "--invariant=invariant",
  `--out-itf=${path.join(out, "trace-{seq}.itf.json")}`,
  "--verbosity=0",
]);
const files = (await readdir(out)).filter((n) =>
  /^trace-\d+\.itf\.json$/.test(n),
);
assert.equal(files.length, 50);
const lines = [];
for (const name of files) {
  const t = JSON.parse(await readFile(path.join(out, name), "utf8"));
  assert.equal(t.vars.length, 1);
  for (const row of t.states) {
    const s = row[t.vars[0]];
    lines.push(s.operation + "\t" + s.phase);
  }
}
const vectors = path.join(out, "vectors.tsv");
await writeFile(vectors, lines.join("\n") + "\n");
const java = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin/java")
    : "java",
  javac = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin/javac")
    : "javac";
run(javac, [
  "--release",
  "17",
  "-d",
  out,
  "packages/os/android/system-updater/src/ai/eliza/systemupdater/UpdateJournal.java",
  "packages/os/android/system-updater/test/ai/eliza/systemupdater/JournalReplay.java",
]);
const result = run(java, [
  "-cp",
  out,
  "ai.eliza.systemupdater.JournalReplay",
  vectors,
]);
assert.match(
  result,
  new RegExp(`PASS ${lines.length} production journal states`),
);
await writeFile(
  path.join(out, "result.json"),
  JSON.stringify({
    traces: files.length,
    states: lines.length,
    implementation: "production UpdateJournal.java",
    androidQualified: false,
  }) + "\n",
);
process.stdout.write(result);
