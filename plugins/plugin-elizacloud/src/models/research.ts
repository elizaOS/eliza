/**
 * Preserves the published Cloud research import while making its retirement
 * explicit. Real research must be supplied by a provider that registers RESEARCH.
 */
import {
  ElizaError,
  type IAgentRuntime,
  type ResearchParams,
  type ResearchResult,
} from "@elizaos/core";

/** Builds the stable typed failure returned by the compatibility handler. */
function unavailableResearchError(): ElizaError {
  return new ElizaError(
    "Eliza Cloud no longer provides a RESEARCH model; install a research-capable provider",
    {
      code: "ELIZA_CLOUD_RESEARCH_UNAVAILABLE",
      severity: "fatal",
    },
  );
}

/**
 * @deprecated Eliza Cloud research was retired. Install a provider that
 * registers `ModelType.RESEARCH` and call it through `runtime.useModel`.
 */
export async function handleResearch(
  _runtime: IAgentRuntime,
  _params: ResearchParams,
): Promise<ResearchResult> {
  throw unavailableResearchError();
}
