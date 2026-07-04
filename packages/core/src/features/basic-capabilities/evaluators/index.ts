/**
 * Barrel for the basic-capabilities inbound auto-capture evaluators, collected
 * into `basicCapabilitiesEvaluators` for the runtime's evaluator registry.
 */
import type { RegisteredEvaluator } from "../../../types/index.ts";
import { linkExtractionEvaluator } from "./link-extraction.ts";

export { linkExtractionEvaluator } from "./link-extraction.ts";

/**
 * Inbound auto-capture evaluators.
 *
 * Runs on every inbound message (gated by `shouldRun`) and writes structured
 * records to memory as a side effect. Never modifies the agent's response and
 * never blocks the planner — failures are logged and swallowed.
 *
 * Image attachments are not analyzed here: inbound images are described during
 * message processing via the shared image-description cache, so a post-response
 * evaluator would only duplicate that vision call.
 */
export const basicCapabilitiesEvaluators: RegisteredEvaluator[] = [
	linkExtractionEvaluator,
];
