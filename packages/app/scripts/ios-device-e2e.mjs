#!/usr/bin/env node
/**
 * Physical iPhone end-to-end orchestrator for the app package.
 *
 * This is the one-command lane for paired phones: deploy the current tree with
 * the unattended signing recipe, drive the committed BootCapture XCUITest
 * harness, pull the boot trace without console-mode SIGTRAPs, and assemble the
 * same triage bundle used by the simulator/Android e2e runners.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  captureFailureForensics,
  collectBundleArtifacts,
  createDeviceE2eBundle,
  finalizeDeviceE2eBundle,
  formatFailureForensicsBlock,
  runBundledCommand,
} from "./lib/device-e2e-bundle.mjs";
import { acquireDeviceLease } from "./lib/device-lease.mjs";
import {
  buildPhysicalIosDevicePlan,
  parseIosDeviceE2eArgs,
} from "./lib/ios-device-e2e-plan.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(scriptDir, "..");
const log = (message) => console.log(`[ios-device-e2e] ${message}`);

function capturePhysicalFailure(bundle, step, error) {
  return captureFailureForensics(
    bundle,
    step,
    ({ failureDir }) => {
      const causePath = path.join(failureDir, "failure-cause.txt");
      fs.writeFileSync(causePath, `${error?.message ?? error}\n`);
      return [causePath];
    },
    error,
  );
}

async function main() {
  const flags = parseIosDeviceE2eArgs(process.argv.slice(2));
  const bundle = createDeviceE2eBundle({
    appDir,
    lane: "ios-device",
    outputDir: flags.output,
    device: {
      kind: "ios-device",
      id: flags.device ?? process.env.ELIZA_IOS_DEVICE_ID ?? null,
    },
  });
  const paths = {
    stagingDir: path.join(bundle.rawDir, "device-deploy-stage"),
    stagedApp: path.join(bundle.rawDir, "device-deploy-stage", "App.app"),
    captureDir: path.join(bundle.rawDir, "ios-device-capture"),
    bootTraceOutput: path.join(bundle.logsDir, "ios-device-boot-trace.log"),
  };
  const plan = buildPhysicalIosDevicePlan(flags, paths);
  let finalResult = "failed";
  let finalError = null;
  let lease = null;

  if (!flags.includeAppexes) {
    log(
      "--skip-appexes is enabled by default: widgets/keyboard/device-activity extensions are excluded from this physical smoke install.",
    );
  }
  log(`bundle root: ${bundle.root}`);

  try {
    const deviceKey = flags.device ?? process.env.ELIZA_IOS_DEVICE_ID ?? null;
    if (deviceKey) {
      lease = await acquireDeviceLease(`ios-device:${deviceKey}`, {
        waitMs: flags.noWait ? 0 : undefined,
        log,
      });
    }
    for (const step of plan) {
      log(`${step.label}…`);
      runBundledCommand(bundle, step.label, step.cmd, step.args, {
        cwd: appDir,
        onFailure: (bundleStep, error) =>
          capturePhysicalFailure(bundle, bundleStep, error),
      });
    }
    finalResult = "passed";
    log("ALL PHYSICAL iOS E2E PASSED");
  } catch (error) {
    finalError = error;
    throw error;
  } finally {
    collectBundleArtifacts(bundle, [
      bundle.rawDir,
      bundle.logsDir,
      paths.captureDir,
      path.dirname(paths.bootTraceOutput),
    ]);
    const bundleRoot = finalizeDeviceE2eBundle(bundle, finalResult);
    if (finalError) {
      const block = formatFailureForensicsBlock(bundle, finalError);
      if (block) process.stderr.write(`\n${block}`);
    }
    lease?.release();
    log(`bundle: ${bundleRoot}`);
  }
}

main().catch((error) => {
  console.error(`[ios-device-e2e] FAILED: ${error?.message ?? error}`);
  process.exit(1);
});
