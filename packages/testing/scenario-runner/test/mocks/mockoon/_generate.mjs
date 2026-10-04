#!/usr/bin/env node
/** Optional Mockoon export of the canonical route catalog; no second fixture registry. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { testOutputPath } from "../../../../../scripts/lib/test-output.ts";

const ports = JSON.parse(
  await readFile(
    new URL(
      "../../../../scripts/mocks/compatibility-ports.json",
      import.meta.url,
    ),
    "utf8",
  ),
);
const output = testOutputPath("mock-services", "mockoon");
await mkdir(output, { recursive: true });
for (const entry of ports) {
  const environment = JSON.parse(
    await readFile(
      new URL(`../environments/${entry.service}.json`, import.meta.url),
      "utf8",
    ),
  );
  await writeFile(
    path.join(output, `${entry.connector}.json`),
    `${JSON.stringify(
      { ...environment, port: entry.port, hostname: "127.0.0.1" },
      null,
      2,
    )}\n`,
  );
}
console.log(`Exported ${ports.length} environments to ${output}`);
