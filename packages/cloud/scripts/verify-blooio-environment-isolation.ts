#!/usr/bin/env node
/**
 * Deploy-time Blooio environment isolation check (#22787).
 *
 * Reads DEPLOY_ENVIRONMENT and ELIZA_APP_BLOOIO_PHONE_NUMBER from the
 * protected job environment and never prints the number. A non-production
 * deployment configured with a production sender is reported as an error
 * annotation. The runtime guards in the Worker edge and the webhook gateway
 * disable Blooio for that environment. `--enforce` also fails the job, for
 * use once staging owns its own Blooio account.
 */
import {
  blooioSenderIsolationViolation,
  classifyBlooioEnvironment,
} from "../services/_common/src/blooio-environment.ts";

const enforce = process.argv.includes("--enforce");
const deployEnvironment = process.env.DEPLOY_ENVIRONMENT ?? "";
const environment = classifyBlooioEnvironment(deployEnvironment);
if (environment === null) {
  console.error(
    "::error::DEPLOY_ENVIRONMENT is required for the Blooio isolation check",
  );
  process.exit(1);
}

const violation = blooioSenderIsolationViolation({
  environment,
  senderNumber: process.env.ELIZA_APP_BLOOIO_PHONE_NUMBER,
});
if (violation) {
  console.log(
    `::error::The protected ${deployEnvironment} Blooio sender is a production line (${violation}). ` +
      "Blooio stays disabled in this environment at runtime until it is provisioned with its own account, sender number and webhook secret.",
  );
  process.exit(enforce ? 1 : 0);
}
console.log(
  `Blooio sender for ${deployEnvironment} is environment-isolated; the value was not printed.`,
);
