import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { before, describe, test } from "node:test";
import { entry, recall, store } from "../cache.ts";
import { bin, exec } from "../run.ts";
import { sha } from "../util.ts";
import { isolatedInstalls } from "./install.ts";

const EXAMPLES = "vibestack/examples";

// The examples are the tools' own subjects: checked here, where the tools test themselves, and never by an application
// built on them, whose check reaches only its own packages and whose installed toolchain carries no example.
export async function exampleCheckKeys(root: string, turbo: string): Promise<Map<string, string>> {
  const planned = await exec(turbo, ["run", "//#selftest:examples", "--dry=json"], root, { ...process.env, TURBO_TELEMETRY_DISABLED: "1" });
  assert.equal(planned.status, 0, planned.stderr);
  const Schema = await import("effect/Schema");
  const plan = Schema.decodeUnknownSync(Schema.Struct({
    globalCacheInputs: Schema.Record(Schema.String, Schema.Unknown),
    tasks: Schema.Array(Schema.Struct({
      taskId: Schema.String,
      inputs: Schema.Record(Schema.String, Schema.String),
      command: Schema.String,
      dependencies: Schema.Array(Schema.String),
      envMode: Schema.String,
      environmentVariables: Schema.Record(Schema.String, Schema.Unknown),
      resolvedTaskDefinition: Schema.Struct({ cache: Schema.Boolean }),
    })),
  }))(JSON.parse(planned.stdout));
  const task = plan.tasks.find(({ taskId }) => taskId === "//#selftest:examples");
  assert.ok(task);
  if (task.dependencies.length || !task.resolvedTaskDefinition.cache) return new Map();
  const { inputs, ...settings } = task;
  const common: [string, string][] = [];
  const examples = new Map<string, [string, string][]>();
  for (const [file, hash] of Object.entries(inputs).sort(([a], [b]) => a.localeCompare(b))) {
    const name = file.startsWith(`${EXAMPLES}/`) ? file.slice(EXAMPLES.length + 1).split("/", 1)[0] : undefined;
    if (!name) common.push([file, hash]);
    else {
      const owned = examples.get(name) ?? [];
      owned.push([file, hash]);
      examples.set(name, owned);
    }
  }
  const shared = sha(JSON.stringify(plan.globalCacheInputs), JSON.stringify(settings), JSON.stringify(common));
  return new Map([...examples].map(([name, owned]) => [name, sha(shared, JSON.stringify(owned))]));
}

if (import.meta.main) describe("the standalone examples", () => {
  isolatedInstalls();
  const project = path.resolve(import.meta.dirname, "../..");
  const turbo = () => bin("turbo", project);
  let keys: Map<string, string> | undefined;
  before(async () => { if (process.env.TURBO_HASH) keys = await exampleCheckKeys(project, turbo()); });
  for (const name of fs.readdirSync(path.join(project, EXAMPLES)).sort())
    test(`the ${name} example installs from its own lock file and passes its check, its page explored where it has one`, async (context) => {
      const example = path.join(project, EXAMPLES, name);
      const memory = { root: example, fresh: false, used: new Set<string>() };
      const key = keys?.get(name);
      const receipt = key ? await entry(example, "tests", ["standalone example check", key]) : undefined;
      if (receipt && recall(memory, receipt) === true) {
        context.diagnostic("Reused a complete standalone install and check for these inputs");
        return;
      }
      const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      const installed = await exec(pnpm, ["install", "--frozen-lockfile", "--ignore-workspace"], example);
      assert.equal(installed.status, 0, installed.stdout + installed.stderr);
      const checked = await exec(pnpm, ["check"], example);
      assert.equal(checked.status, 0, `${checked.stdout}${checked.stderr}`.trim().split("\n").slice(-80).join("\n"));
      if (receipt && (await exampleCheckKeys(project, turbo())).get(name) === key) store(memory, receipt, true);
    });
});
