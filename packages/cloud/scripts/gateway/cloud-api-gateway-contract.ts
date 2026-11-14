/**
 * Exit-code contract shared by the production Cloud API gateway verifier chain
 * (onboarding flow -> production verify -> maintain). Only an explicit drift
 * exit authorizes the maintain script to redeploy production; every other
 * non-zero exit (network failure, auth failure, crash, signal) is a verifier
 * failure that must surface instead of triggering a deploy.
 */
export const GATEWAY_CONTRACT_DRIFT_EXIT_CODE = 3;

/** The live Worker answered, but its gateway identity no longer matches. */
export class GatewayContractDriftError extends Error {
  readonly exitCode = GATEWAY_CONTRACT_DRIFT_EXIT_CODE;

  constructor(message: string) {
    super(message);
    this.name = "GatewayContractDriftError";
  }
}
