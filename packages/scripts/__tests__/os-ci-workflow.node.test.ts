import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parse } from "yaml";

test("canonical CI requires reusable OS verification and propagates failure", () => {
  const load = (name) =>
    parse(
      readFileSync(
        new URL(`../../../.github/workflows/${name}`, import.meta.url),
        "utf8",
      ),
    );
  const os = load("os.yml");
  const ci = load("ci.yml");
  assert.deepEqual(Object.keys(os.on).sort(), [
    "workflow_call",
    "workflow_dispatch",
  ]);
  assert.equal(ci.jobs.os.uses, "./.github/workflows/os.yml");
  assert.ok(ci.jobs.required.needs.includes("os"));
  const aggregate = ci.jobs.required.steps.find((step) => step.env?.RESULTS);
  assert.match(aggregate.env.RESULTS, /os=\$\{\{ needs\.os\.result \}\}/);
  for (const result of ["success", "failure", "cancelled", "skipped"]) {
    const execute = () =>
      execFileSync("bash", ["-e", "-c", aggregate.run], {
        env: {
          ...process.env,
          RESULTS: `quality=success:true os=${result}:true`,
        },
        stdio: "pipe",
      });
    if (result === "success") assert.doesNotThrow(execute);
    else assert.throws(execute, (error) => error.status === 1);
  }
  for (const [results, passes] of [
    ["quality=success:true os=skipped:false", true],
    ["quality=success:true os=success:false", false],
    ["quality=success:true os=skipped", false],
    ["quality=success:true os=success:", false],
  ] as const) {
    const execute = () =>
      execFileSync("bash", ["-e", "-c", aggregate.run], {
        env: { ...process.env, RESULTS: results },
        stdio: "pipe",
      });
    if (passes) assert.doesNotThrow(execute);
    else assert.throws(execute, (error) => error.status === 1);
  }
});
