#!/usr/bin/env node
/**
 * GitHub Actions boundary for latest-wins cloud release admission.
 *
 * The workflow supplies already-resolved event and SHA values. This wrapper
 * writes stable step outputs and fails closed when required staging inputs are
 * missing, before installation, compilation, or deployment can begin.
 */

import fs from "node:fs";

import { decideReleaseAdmission } from "./release-admission.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((arg) => {
    const separator = arg.indexOf("=");
    if (separator === -1)
      throw new Error(`Expected --name=value, received ${arg}`);
    return [arg.slice(2, separator), arg.slice(separator + 1)];
  }),
);

const result = decideReleaseAdmission({
  eventName: args.event,
  targetEnvironment: args.environment,
  ref: args.ref,
  force: args.force === "true",
  runDeployedRendererStaging: args["run-deployed-renderer-staging"] === "true",
  runId: args["run-id"],
  latestEligibleRunId: args["latest-eligible-run-id"],
});

// biome-ignore lint/suspicious/noUndeclaredEnvVars: GitHub Actions provides this step-output path.
const outputPath = process.env.GITHUB_OUTPUT;
if (!outputPath) throw new Error("GITHUB_OUTPUT is required");

fs.appendFileSync(
  outputPath,
  `should_deploy=${result.shouldDeploy}\nreason=${result.reason}\n`,
);
console.log(
  `release-admission: ${result.shouldDeploy ? "admit" : "skip"} (${result.reason})`,
);
