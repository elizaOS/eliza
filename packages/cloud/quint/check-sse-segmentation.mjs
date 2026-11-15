/** Connect the finite segmentation model to the real byte-oriented meter. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const output = testOutputPath("quint-sse-segmentation");
await mkdir(output, { recursive: true });
const runDirectory = await mkdtemp(path.join(output, "run-"));
const report = path.join(runDirectory, "tests.xml");
const result = spawnSync(
  "bun",
  [
    "test",
    "packages/cloud/shared/src/lib/services/__tests__/inference-passthrough-fragments.test.ts",
    "--max-concurrency=1",
    "--reporter=junit",
    `--reporter-outfile=${report}`,
  ],
  { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
);
if (result.error) throw result.error;
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.signal) process.kill(process.pid, result.signal);
assert.equal(result.status, 0, "SSE implementation checks failed");
const xml = await readFile(report, "utf8");
assert(
  !/<(?:failure|error|skipped)\b/.test(xml),
  "JUnit contains a failure or skipped check",
);
const names = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)]
  .map((match) => match[1])
  .sort();
assert.deepEqual(
  names,
  [
    "every split including multibyte UTF-8 and CRLF preserves content and usage",
    "a long fragmented event retains every character without truncation",
    "empty lines, malformed events and final unterminated data retain prior valid usage",
    "abort does not parse an incomplete event and later bytes cannot change the terminal receipt",
    "an error after DONE remains observable until actual stream termination",
  ].sort(),
  "Required meter checks were not all executed",
);
await writeFile(
  path.join(output, "results.json"),
  `${JSON.stringify(
    {
      result: "passed",
      tests: names,
      report,
    },
    null,
    2,
  )}\n`,
);
