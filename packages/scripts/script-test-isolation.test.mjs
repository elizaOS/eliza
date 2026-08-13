/**
 * Proves Bun's parallel file mode isolates process-global script-test state.
 * Four synchronized fixture suites must have distinct PIDs while one mutates
 * cwd, environment, globals, module state, signal handlers, and scratch files.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "./lib/spawn-sync-captured.mjs";

// The four spawned suites do real subprocess work with a 20s exec budget; the
// runner's 5s default test timeout undercut that on a loaded CI host (10.9s
// observed on the scenario-runner lane).
test("parallel script suites run in isolated worker processes", {
  timeout: 60_000,
}, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "script-test-isolation-"));
  try {
    fs.mkdirSync(path.join(root, "changed-cwd"));
    fs.writeFileSync(
      path.join(root, "state.mjs"),
      "export const state = { value: 0 };\n",
    );
    for (let index = 0; index < 4; index += 1) {
      const mutation =
        index === 0
          ? `
  process.env.ELIZA_SCRIPT_ISOLATION_PROBE = "mutated";
  globalThis.__elizaScriptIsolationProbe = "mutated";
  state.value = 1;
  process.on("SIGUSR2", () => {});
  process.chdir(path.join(root, "changed-cwd"));
`
          : `
  expect(process.env.ELIZA_SCRIPT_ISOLATION_PROBE).toBeUndefined();
  expect(globalThis.__elizaScriptIsolationProbe).toBeUndefined();
  expect(state.value).toBe(0);
  expect(process.listenerCount("SIGUSR2")).toBe(0);
  expect(fs.realpathSync(process.cwd())).toBe(fs.realpathSync(root));
`;
      fs.writeFileSync(
        path.join(root, `worker-${index}.test.mjs`),
        `import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { state } from "./state.mjs";

const root = ${JSON.stringify(root)};
fs.writeFileSync(path.join(root, "pid-${index}"), String(process.pid));

test("worker ${index} remains process-isolated", async () => {
${mutation}
  const deadline = Date.now() + 10_000;
  while (fs.readdirSync(root).filter((name) => name.startsWith("pid-")).length < 4) {
    if (Date.now() > deadline) throw new Error("parallel workers did not rendezvous");
    await Bun.sleep(20);
  }
  const pids = fs.readdirSync(root)
    .filter((name) => name.startsWith("pid-"))
    .map((name) => fs.readFileSync(path.join(root, name), "utf8"));
  expect(new Set(pids).size).toBe(4);
});
`,
      );
    }

    const result = spawnSync(
      "bun",
      [
        "test",
        "--parallel=4",
        ...Array.from({ length: 4 }, (_, index) => `worker-${index}.test.mjs`),
      ],
      { cwd: root, encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(
      result.status,
      0,
      `isolation fixture failed:\n${result.stdout}\n${result.stderr}`,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
