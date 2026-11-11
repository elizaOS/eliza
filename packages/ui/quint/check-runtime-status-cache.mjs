/** Run the complete source-client suite and reject missing or skipped checks. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const model = path.join(root, "packages/ui/quint/RuntimeStatusCache.qnt");
if (process.argv[2]) assert.equal(path.resolve(process.argv[2]), model);
const test = "src/api/__e2e__/runtime-json-client.test.ts";
const expected = [
  "runtime JSON client native status reuse probes status before every request by default",
  "runtime JSON client native status reuse probes once per account generation while the runtime stays running",
  "runtime JSON client native status reuse starts a stopped runtime and sends an undispatched request once",
  "runtime JSON client native status reuse never resends after another rejection, and probes the next request",
  "runtime JSON client native status reuse never resends a not-ready rejection by default",
  "runtime JSON client native status reuse does not start an unavailable runtime after a not-ready rejection",
  "runtime JSON client native status reuse does not resend when not-ready repeats after startup",
  "runtime JSON client native status reuse treats a 503 or a not-ready response body as dispatched",
  "runtime JSON client native status reuse reuses the running status that an account refresh established",
  "runtime JSON client native status reuse does not reuse an earlier running status after a failed refresh",
  "runtime JSON client generation ownership fences a refresh between readiness and the first native dispatch",
  "runtime JSON client generation ownership fences a refresh between retry readiness and native redispatch",
  "runtime JSON client generation ownership keeps the current running cache when an old response returns 503",
  "runtime JSON client generation ownership keeps the current refresh receipt when an older refresh fails",
  "runtime JSON client generation ownership recovers only after the host explicitly retries a failed refresh",
];
const outputRoot = testOutputPath("quint-runtime-status-cache");
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
  `RuntimeStatusCache conformance passed all ${checks.length} named real-client checks`,
);
