/** Check the finite startup model against existing real-process host contracts. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../../packages/scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
assert.equal(
  path.resolve(root, process.argv[2] ?? ""),
  path.join(
    root,
    "plugins/plugin-native-agent/quint/ParallelRuntimeStartup.qnt",
  ),
);
const output = testOutputPath("quint-parallel-runtime-startup");
mkdirSync(output, { recursive: true });
const commands = [
  ["plugins/plugin-native-agent/scripts/test-native-host.mjs"],
  [
    "--test",
    "--test-reporter=tap",
    "packages/host/native-host/gateway-bootstrap.test.mjs",
  ],
  [
    "--test",
    "--test-reporter=tap",
    "plugins/plugin-native-agent/test/provider-admission/provider-admission.node.mjs",
    "plugins/plugin-native-agent/test/connection/connection.node.mjs",
  ],
];
for (const [index, args] of commands.entries()) {
  const log = path.join(output, `contract-${index}.log`);
  try {
    const result = execFileSync(
      process.execPath,
      [
        "packages/scripts/run-with-deadline.ts",
        "300000",
        "--",
        process.execPath,
        ...args,
      ],
      {
        cwd: root,
        encoding: "utf8",
        timeout: 320000,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    writeFileSync(log, result);
    if (index === 0) {
      assert.match(result, /NativeRuntimeSession: [1-9]\d* assertions passed/);
      assert.match(result, /EmbeddedRuntimeGroup: [1-9]\d* checks passed/);
    } else {
      assert.match(result, /^# pass [1-9]\d*$/m);
      assert.match(result, /^# fail 0$/m);
      assert.match(result, /^# skipped 0$/m);
    }
  } catch (error) {
    writeFileSync(
      log,
      `${error.stdout ?? ""}${error.stderr ?? ""}\n${String(error)}`,
    );
    throw error;
  }
}
console.log(`Parallel runtime startup contracts passed: ${output}`);
