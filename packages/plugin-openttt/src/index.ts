import type { Plugin } from "@elizaos/core";
import { generatePot } from "./actions/generatePot.js";
import { verifyPot } from "./actions/verifyPot.js";
import { queryPot } from "./actions/queryPot.js";
import { timeProvider } from "./providers/timeProvider.js";
import { potEvaluator } from "./evaluators/potEvaluator.js";

/**
 * OpenTTT Proof-of-Time plugin for ElizaOS.
 *
 * Provides temporal attestation for AI agent transactions using
 * multi-source verified time (NIST, Apple, Google, Cloudflare).
 *
 * Actions:
 *   - GENERATE_POT  — create a PoT token before a trade
 *   - VERIFY_POT    — verify a PoT token after a trade
 *   - QUERY_POT     — inspect cached PoT token(s) for this agent
 *
 * Providers:
 *   - timeProvider  — injects 4-source consensus time into agent context
 *
 * Evaluators:
 *   - potEvaluator  — flags trade messages lacking PoT coverage
 */
export const openTTTPlugin: Plugin = {
  name: "openttt",
  description:
    "OpenTTT Proof-of-Time plugin — temporal attestation for AI agent " +
    "transactions using multi-source verified time.",
  actions: [generatePot, verifyPot, queryPot],
  providers: [timeProvider],
  evaluators: [potEvaluator],
};

export default openTTTPlugin;

// Named exports for direct use
export { generatePot } from "./actions/generatePot.js";
export { verifyPot } from "./actions/verifyPot.js";
export { queryPot } from "./actions/queryPot.js";
export { timeProvider, getVerifiedTime } from "./providers/timeProvider.js";
export { potEvaluator } from "./evaluators/potEvaluator.js";
export type { PoTToken } from "./actions/generatePot.js";
export type { VerifyResult } from "./actions/verifyPot.js";
export type { VerifiedTime } from "./providers/timeProvider.js";
