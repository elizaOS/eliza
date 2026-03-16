import {
  type IAgentRuntime,
  logger,
  type Memory,
  type Provider,
  type ProviderResult,
  type State,
} from "@elizaos/core";
import { requireProviderSpec } from "../generated/specs/spec-helpers";
import type { ExperienceService } from "../service";

/**
 * Simple experience provider that injects relevant experiences into context
 * Similar to the knowledge provider but focused on agent learnings
 */
const spec = requireProviderSpec("experienceProvider");

export const experienceProvider: Provider = {
  name: spec.name,
  description: "Provides relevant past experiences and learnings for the current context",

  async get(runtime: IAgentRuntime, message: Memory, _state?: State): Promise<ProviderResult> {
    const experienceService = runtime.getService("EXPERIENCE") as ExperienceService | null;

    if (!experienceService) {
      return { text: "", data: {}, values: {} };
    }

    // Get message text for context
    const messageText = message.content.text || "";
    if (messageText.length < 10) {
      return { text: "", data: {}, values: {} };
    }

    // Find relevant experiences using semantic search
    const relevantExperiences = await experienceService.queryExperiences({
      query: messageText,
      limit: 5,
      minConfidence: 0.6,
      minImportance: 0.5,
    });

    if (relevantExperiences.length === 0) {
      return { text: "", data: {}, values: {} };
    }

    // Format experiences for context injection
    const experienceText = relevantExperiences
      .map((exp, index) => {
        return `Experience ${index + 1}: In ${exp.domain} context, when ${exp.context}, I learned: ${exp.learning}`;
      })
      .join("\n");

    const contextText = `[RELEVANT EXPERIENCES]\n${experienceText}\n[/RELEVANT EXPERIENCES]`;

    logger.debug(
      `[experienceProvider] Injecting ${relevantExperiences.length} relevant experiences`
    );

    return {
      text: contextText,
      data: {
        experiences: relevantExperiences,
        count: relevantExperiences.length,
      },
      values: {
        experienceCount: relevantExperiences.length.toString(),
      },
    };
  },
};
