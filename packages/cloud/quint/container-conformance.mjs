/** Shared process supervision and strict JUnit checks for container protocols. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));

export async function runContainerConformance(
  id,
  suites,
  requiresPostgres = false,
) {
  if (requiresPostgres) {
    // biome-ignore lint/suspicious/noUndeclaredEnvVars: the uncached Quint hook requires an isolated QA database.
    const database = process.env.INFERENCE_POLICY_TEST_POSTGRES_URL;
    assert(
      database,
      "Set INFERENCE_POLICY_TEST_POSTGRES_URL to an isolated loopback qa_* PostgreSQL database. See packages/cloud/quint/README.md.",
    );
    const parsed = new URL(database);
    assert(
      ["postgres:", "postgresql:"].includes(parsed.protocol) &&
        ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) &&
        parsed.username.startsWith("qa_"),
      "Container conformance requires an isolated loopback qa_* PostgreSQL role",
    );
  }
  const output = testOutputPath(id);
  await mkdir(output, { recursive: true });
  const directory = await mkdtemp(path.join(output, "run-"));
  const results = [];
  async function run(file, names) {
    const report = path.join(directory, `${results.length}.xml`);
    const child = spawn(
      process.execPath,
      [
        path.join(root, "packages/scripts/run-with-deadline.ts"),
        "240000",
        "--",
        "bun",
        "test",
        "--isolate",
        "--conditions=eliza-source",
        path.join(root, file),
        "--reporter=junit",
        `--reporter-outfile=${report}`,
      ],
      { cwd: root, env: process.env, stdio: "inherit" },
    );
    let interrupted;
    const forward = (signal) => {
      interrupted ??= signal;
      child.kill(signal);
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", terminate);
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        child.once("error", reject);
        child.once("close", (code, signal) => resolve({ code, signal }));
      });
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", terminate);
    }
    if (interrupted || result.signal)
      process.kill(process.pid, interrupted ?? result.signal);
    assert.equal(
      result.code,
      0,
      `Container protocol implementation checks failed for ${file}`,
    );
    const xml = await readFile(report, "utf8");
    assert(!/<(?:failure|error)\b/.test(xml), "JUnit contains a failed check");
    const executed = [
      ...xml.matchAll(/<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g),
    ]
      .filter((match) => !/<skipped\b/.test(match[2] || ""))
      .map((match) => {
        const name = match[1].match(/\bname="([^"]+)"/)?.[1];
        assert(name, "JUnit testcase is missing its name");
        return name
          .replaceAll("&apos;", "'")
          .replaceAll("&quot;", '"')
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&amp;", "&");
      })
      .sort();
    assert.deepEqual(
      executed,
      [...names].sort(),
      "Required Container protocol checks did not all execute",
    );
    results.push({ file, names: executed, report });
  }

  for (const suite of suites) await run(suite.file, suite.names);
  await writeFile(
    path.join(directory, "results.json"),
    `${JSON.stringify({ status: "passed", results }, null, 2)}\n`,
  );
  console.log(
    `Container protocol conformance passed ${results.reduce((sum, result) => sum + result.names.length, 0)} required tests. Results ${directory}`,
  );
}
