/** Check the embedded agent's lifecycle model against its real-process contracts. */
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
    "plugins/plugin-native-agent/quint/EmbeddedAgentLifecycle.qnt",
  ),
);
const output = testOutputPath("quint-embedded-agent-lifecycle");
mkdirSync(output, { recursive: true });
const contracts = [
  {
    args: ["plugins/plugin-native-agent/scripts/test-native-host.mjs"],
    evidence: [
      /NativeProcessSupervisor: [1-9]\d* assertions passed/,
      /EmbeddedRuntimeGroup: [1-9]\d* checks passed/,
    ],
  },
  {
    args: [
      "--test",
      "--test-reporter=tap",
      "plugins/plugin-native-agent/test/native-host/embedded-agent.node.mjs",
      "plugins/plugin-native-agent/test/embedded/embedded.node.mjs",
    ],
    evidence: [/^# pass [1-9]\d*$/m, /^# fail 0$/m, /^# skipped 0$/m],
  },
];
for (const [index, { args, evidence }] of contracts.entries()) {
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
    for (const pattern of evidence) assert.match(result, pattern);
  } catch (error) {
    writeFileSync(
      log,
      `${error.stdout ?? ""}${error.stderr ?? ""}\n${String(error)}`,
    );
    throw error;
  }
}
console.log(`Embedded agent lifecycle contracts passed: ${output}`);
