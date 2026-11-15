/** Checks broker receipt ownership against the default encrypted account store. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";
import { requireVitestConformance } from "../../scripts/lib/vitest-conformance.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const testFile = "src/accounts/account-pool-broker.test.ts";
const output = testOutputPath("quint-account-pool-broker");
await mkdir(output, { recursive: true });
const directory = await mkdtemp(path.join(output, "run-"));
const report = path.join(directory, "tests.json");
const run = spawnSync(
  process.execPath,
  [
    "../scripts/run-vitest.ts",
    "run",
    testFile,
    "--cache=false",
    "--reporter=json",
    `--outputFile=${report}`,
  ],
  { cwd: path.join(root, "packages/auth"), encoding: "utf8", timeout: 360_000 },
);
await writeFile(
  path.join(directory, "tests.log"),
  `${run.stdout ?? ""}\n${run.stderr ?? ""}`,
);
if (run.error) throw run.error;
assert.equal(
  run.signal,
  null,
  `Broker conformance terminated by ${run.signal}`,
);
assert.equal(
  run.status,
  0,
  `Broker conformance failed. See ${directory}/tests.log`,
);
const cases = requireVitestConformance(
  JSON.parse(await readFile(report, "utf8")),
  path.join(root, "packages/auth", testFile),
  [
    "fences a replaced credential from an old broker 401 report",
    "fences a replaced credential from an old broker 429 report",
    "keeps broker token and organization on the same resolution receipt",
    "refuses a broker token whose credential changed before publication",
    "preserves a later failure while an older broker success awaits accounting",
    "rechecks a broker health baseline inside the metadata writer",
    "starts broker expiry after resolution and preserves legacy resolver wire shape",
  ],
);
console.log(
  `Account-pool broker conformance passed all ${cases.length} named cases. Evidence ${directory}`,
);
