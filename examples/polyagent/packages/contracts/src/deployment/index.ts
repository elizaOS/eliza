/**
 * @packageDocumentation
 * @module @polyagent/contracts/deployment
 *
 * Deployment Utilities
 *
 * Tools for contract deployment validation, environment detection, and address management.
 * Provides utilities for loading contract addresses, detecting deployment environments,
 * and validating contract deployments on-chain.
 *
 * @remarks For Node.js-only functions like `saveDeployment` and `updateEnvFile`,
 * import directly from `@polyagent/contracts/deployment/validation-node`.
 */

export * from "./addresses";
export * from "./env-detection";
export * from "./validation";
