/** Runs the native HTTP/file regressions alongside the finite cache model. */
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { testOutputPath } from "../../scripts/lib/test-output.ts";

const root = path.resolve(import.meta.dirname, "../../..");
const output = testOutputPath("cloud-formal", "conformance", "native-access");
mkdirSync(output, { recursive: true });
const result = spawnSync(
  process.execPath,
  [
    "--test",
    "packages/cloud/sdk/native-host/cloud-services.test.mjs",
    "packages/agent/native-host/gateway.e2e.test.mjs",
    "packages/host/native-host/gateway-bootstrap.test.mjs",
  ],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
  },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
writeFileSync(path.join(output, "native-tests.log"), log);
process.stdout.write(log);
if (result.error) throw result.error;
if (result.status !== 0)
  throw new Error(
    `Native access conformance failed: ${result.status ?? result.signal}`,
  );
