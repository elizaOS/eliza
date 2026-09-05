/** Verifies a retained Cloud stability aggregate before it is consumed as evidence. */

import path from "node:path";
import { verifyCloudStabilityArtifacts } from "../src/stability/cloud-stability-runner.ts";

const outputOption = process.argv.indexOf("--output");
const suppliedOutput =
  outputOption >= 0 ? process.argv[outputOption + 1] : undefined;
if (!suppliedOutput) {
  throw new Error("stability:verify requires --output <artifact-directory>");
}

const outputRoot = path.resolve(suppliedOutput);
const verified = await verifyCloudStabilityArtifacts(outputRoot);
process.stdout.write(
  `${JSON.stringify({
    outputRoot,
    reportSha256: verified.reportSha256,
    runId: verified.manifest.runId,
    mode: verified.manifest.mode,
  })}\n`,
);
