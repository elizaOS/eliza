#!/usr/bin/env node
/** Machine-readable distinction between a build and a booted qualification run. */
import fs from "node:fs";
import { requireThat } from "./release-contract.mjs";

try {
  const [output, launch, jobStatus, osCommit] = process.argv.slice(2);
  requireThat(
    process.argv.length === 6 &&
      ["true", "false"].includes(launch) &&
      /^[a-f0-9]{40}$/.test(osCommit),
    "invalid Cuttlefish result arguments",
  );
  const record = {
    schemaVersion: 1,
    kind: "cuttlefish-workflow-result",
    osCommit,
    launch: launch === "true",
    jobStatus,
    status:
      launch === "true" && jobStatus === "success"
        ? "workflow-passed"
        : "unqualified",
    qualification: false,
    note: "This workflow receipt is not signed release qualification; bind exact output hashes and all required test evidence before signing.",
  };
  fs.mkdirSync(new URL("../../reports/cuttlefish/", import.meta.url), {
    recursive: true,
  });
  fs.writeFileSync(output, `${JSON.stringify(record, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
