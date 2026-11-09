/** Real nested-supervisor checks for late and signal-ignoring checker processes. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "./lib/test-output.ts";

const scriptRoot = path.dirname(fileURLToPath(import.meta.url));
const outputRoot = testOutputPath("quint-runner-tests");
function running(pid: number): boolean {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return (
      stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z"
    );
  } catch (error) {
    if (
      ["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")
    )
      return false;
    throw error;
  }
}
async function until(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (!ready()) {
    assert(
      Date.now() < deadline,
      "timed out waiting for nested checker evidence",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
function readPid(file: string): number | undefined {
  try {
    const pid = Number(readFileSync(file, "utf8"));
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}
async function runNestedCancellation(
  signal: NodeJS.Signals,
  late: boolean,
): Promise<void> {
  mkdirSync(outputRoot, { recursive: true });
  const directory = mkdtempSync(path.join(outputRoot, "nested-repository-"));
  const evidence = mkdtempSync(path.join(outputRoot, "nested-evidence-"));
  const write = (name: string, content: string) => {
    const target = path.join(directory, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const sourceHashes: Record<string, string> = {};
  for (const file of [
    "check-quint.ts",
    "run-with-deadline.ts",
    "lib/test-output.ts",
    "lib/quint-shards.ts",
  ]) {
    const content = readFileSync(path.join(scriptRoot, file), "utf8");
    write(`packages/scripts/${file}`, content);
    sourceHashes[file] = createHash("sha256").update(content).digest("hex");
  }
  write(".gitignore", "test-results/\nnode_modules\n");
  write("source.ts", "export const state = 'active';\n");
  write(
    "packages/example/quint/Example.qnt",
    `module Example {
    var state: int
    action init = state' = 0
    action step = state' = 1
    val Safe = state == 0 or state == 1
  }`,
  );
  write(
    "packages/example/quint/Example.cases.json",
    JSON.stringify({
      sources: ["source.ts"],
      conformance: "packages/example/quint/conformance.mjs",
      cases: [
        {
          name: "bounded",
          main: "Example",
          init: "init",
          step: "step",
          invariants: ["Safe"],
          temporal: [],
          maxSteps: 2,
          samples: 1,
        },
      ],
    }),
  );
  const childSource = `const fs = require('node:fs');
    process.on('SIGINT', () => {}); process.on('SIGTERM', () => {});
    fs.writeFileSync('test-results/ready-child', String(process.pid));
    setInterval(() => {}, 1000);`;
  write(
    "packages/example/quint/conformance.mjs",
    `import { spawn } from 'node:child_process';
    import { existsSync, writeFileSync } from 'node:fs';
    writeFileSync('test-results/ready-worker', String(process.ppid));
    let child;
    const start = () => { child ??= spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], { stdio: 'inherit' }); };
    process.on('SIGINT', ${late ? "start" : "() => {}"});
    process.on('SIGTERM', ${late ? "start" : "() => {}"});
    ${late ? "writeFileSync('test-results/ready-parent', String(process.pid));" : "start(); const ready = setInterval(() => { if (existsSync('test-results/ready-child')) { writeFileSync('test-results/ready-parent', String(process.pid)); clearInterval(ready); } }, 10);"}
    setInterval(() => {}, 1000);`,
  );
  symlinkSync(
    path.resolve(scriptRoot, "../../node_modules"),
    path.join(directory, "node_modules"),
    "dir",
  );
  execFileSync("git", ["init", "--quiet", directory]);
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Quint test",
      "-c",
      "user.email=quint-test@example.invalid",
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "--no-verify",
      "--quiet",
      "-m",
      "fixture",
    ],
    { cwd: directory },
  );
  const wrapper = spawn(
    process.execPath,
    [
      path.join(directory, "packages/scripts/run-with-deadline.ts"),
      "300000",
      "--",
      process.execPath,
      path.join(directory, "packages/scripts/check-quint.ts"),
      "--simulate",
    ],
    { cwd: directory, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  wrapper.stdout.on("data", (chunk) => {
    output += chunk;
  });
  wrapper.stderr.on("data", (chunk) => {
    output += chunk;
  });
  const closed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    wrapper.once("error", reject);
    wrapper.once("close", (code, observedSignal) =>
      resolve({ code, signal: observedSignal }),
    );
  });
  const pids: number[] = [];
  let controller: number | undefined;
  try {
    await until(
      () =>
        readPid(path.join(directory, "test-results/ready-parent")) !==
        undefined,
    );
    const children = readFileSync(
      `/proc/${wrapper.pid}/task/${wrapper.pid}/children`,
      "utf8",
    )
      .trim()
      .split(/\s+/)
      .map(Number);
    assert.equal(children.length, 1);
    controller = children[0];
    assert(
      readFileSync(`/proc/${controller}/cmdline`, "utf8").includes(
        path.join(directory, "packages/scripts/check-quint.ts"),
      ),
    );
    // Hold the owned controller group for half a second, so an enclosing grace
    // timer starts before the nested owner can process its signal.
    process.kill(-controller, "SIGSTOP");
    wrapper.kill(signal);
    await new Promise((resolve) => setTimeout(resolve, 500));
    process.kill(-controller, "SIGCONT");
    if (late)
      await until(
        () =>
          readPid(path.join(directory, "test-results/ready-child")) !==
          undefined,
      );
    for (const file of ["ready-worker", "ready-parent", "ready-child"]) {
      const pid = readPid(path.join(directory, "test-results", file));
      assert(pid, `missing ${file}`);
      pids.push(pid);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      closed,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("nested supervisor did not finish")),
          25_000,
        );
      }),
    ]).finally(() => clearTimeout(timer));
    const survivors = pids.filter(running);
    writeFileSync(
      path.join(evidence, "result.json"),
      JSON.stringify(
        { signal, late, sourceHashes, result, pids, survivors },
        null,
        2,
      ),
    );
    writeFileSync(path.join(evidence, "output.log"), output);
    assert.equal(result.code, signal === "SIGINT" ? 130 : 143);
    assert.deepEqual(
      survivors,
      [],
      `nested checker survived cancellation; evidence ${evidence}`,
    );
    const report = JSON.parse(
      readFileSync(
        path.join(directory, "test-results/quint/simulation.json"),
        "utf8",
      ),
    );
    assert.equal(report.completed, false);
  } finally {
    if (controller !== undefined) {
      try {
        process.kill(-controller, "SIGCONT");
      } catch {}
    }
    for (const file of ["ready-worker", "ready-parent", "ready-child"]) {
      const pid = readPid(path.join(directory, "test-results", file));
      if (pid !== undefined) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {}
      }
    }
    wrapper.kill("SIGKILL");
    await closed;
    rmSync(directory, { recursive: true, force: true });
  }
}
for (const late of [false, true]) {
  test(late
    ? "nested CLI cancellation reaps descendants spawned after cancellation"
    : "nested CLI cancellation reaps signal-ignoring checker descendants", {
    timeout: 90_000,
    skip: process.platform !== "linux" ? "Linux process-group schedule" : false,
  }, async () => {
    for (const signal of ["SIGINT", "SIGTERM"] as const)
      await runNestedCancellation(signal, late);
  });
}
