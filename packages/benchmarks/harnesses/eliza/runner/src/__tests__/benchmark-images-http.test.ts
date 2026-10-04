/** Real HTTP/runtime/provider-boundary checks; fixtures are not benchmark scores. */
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { testOutputPath } from "../../../../../../scripts/lib/test-output.ts";

const exec = promisify(execFile);
const startupSeconds = Number(
  process.env.ELIZA_BENCH_TEST_STARTUP_TIMEOUT_S ?? 90,
);
if (!Number.isFinite(startupSeconds) || startupSeconds <= 0) {
  throw new Error(
    "ELIZA_BENCH_TEST_STARTUP_TIMEOUT_S must be finite and positive",
  );
}
const fixtureTimeoutMs = (startupSeconds + 25) * 1000;
const fixture = path.join(import.meta.dirname, "fixtures/vision-http.py");
const serverEntry = path.resolve(import.meta.dirname, "../cli.ts");

describe("native benchmark image transport", () => {
  for (const [name, flag] of [
    ["rejects disabled vision", ""],
    ["delivers image bytes and records model usage", "--positive"],
    ["rejects a failed native turn", "--invalid-agent"],
    ["delivers VisualWebBench attachments", "--visualwebbench"],
  ]) {
    it(
      name,
      async () => {
        const { stdout } = await exec(
          "python3",
          [fixture, ...(flag ? [flag] : [])],
          {
            env: {
              ...process.env,
              BENCHMARK_VISION_SERVER_ENTRY: serverEntry,
              BENCHMARK_VISION_TEST_OUTPUT: testOutputPath(
                "benchmark-vision-http",
                flag.slice(2) || "disabled",
              ),
            },
            timeout: fixtureTimeoutMs,
            maxBuffer: 1024 * 1024,
          },
        );
        expect(stdout).toContain("PASS:");
      },
      fixtureTimeoutMs + 5_000,
    );
  }
});
