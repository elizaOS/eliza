/** Run the real gate/scheduler source suite; require every named scenario. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(
  root,
  "packages/ui/quint/AutomaticAppUpdateSchedule.qnt",
);
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "src/state/__e2e__/app-update-gate.test.ts";
const expected = [
  "app update gate keeps polling while foreground and backs off failed checks",
  "app update gate retires a background generation without overlapping its pending operation",
  "app update gate disposes timer ownership while a native call remains pending",
  "app update gate captures editing before modal focus and refuses automatic preparation quietly",
  "app update gate keeps an explicit refusal visible while preserving native acknowledgment binding",
  "app update gate forwards automatic editing admission on startup readback without a ready event",
];
const outputRoot = testOutputPath("quint-app-update-schedule");
mkdirSync(outputRoot, { recursive: true });
const output = mkdtempSync(path.join(outputRoot, "conformance-"));
const reportPath = path.join(output, "vitest.json");
const child = spawnSync(
  process.execPath,
  [
    path.join(root, "packages/scripts/run-vitest.ts"),
    "run",
    "--config",
    "vitest.config.ts",
    "--no-file-parallelism",
    test,
    "--reporter=json",
    `--outputFile=${reportPath}`,
  ],
  {
    cwd: path.join(root, "packages/ui"),
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      NODE_OPTIONS:
        `${process.env.NODE_OPTIONS ?? ""} --no-experimental-webstorage --disable-warning=ExperimentalWarning`.trim(),
    },
  },
);
writeFileSync(
  path.join(output, "output.log"),
  `${child.stdout ?? ""}\n${child.stderr ?? ""}`,
);
if (child.error) throw child.error;
if (child.signal) process.kill(process.pid, child.signal);
assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
const checks = requireVitestConformance(
  JSON.parse(readFileSync(reportPath, "utf8")),
  path.join(root, "packages/ui", test),
  expected,
);
writeFileSync(
  path.join(output, "checked.json"),
  `${JSON.stringify(checks, null, 2)}\n`,
);
console.log(
  `AutomaticAppUpdateSchedule conformance passed all ${checks.length} named gate/scheduler checks`,
);
