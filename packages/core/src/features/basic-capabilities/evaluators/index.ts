import type { RegisteredEvaluator } from "../../../types/index.ts";
import { attachmentImageAnalysisEvaluator } from "./attachment-image-analysis.ts";
import { linkExtractionEvaluator } from "./link-extraction.ts";

export { attachmentImageAnalysisEvaluator } from "./attachment-image-analysis.ts";
export { linkExtractionEvaluator } from "./link-extraction.ts";

/**
 * Inbound auto-capture evaluators.
 *
 * Both run on every inbound message (gated by their `shouldRun`) and write
 * structured records to memory as a side effect. They never modify the
 * agent's response and never block the planner — failures are logged and
 * swallowed.
 */
export const basicCapabilitiesEvaluators: RegisteredEvaluator[] = [
	attachmentImageAnalysisEvaluator,
	linkExtractionEvaluator,
];
