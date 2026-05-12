/**
 * Shared AgentSkillsService interface.
 *
 * Subset of the AgentSkillsService type as exposed by @elizaos/plugin-agent-skills.
 * Declared here to avoid importing the package from multiple consumers.
 */

export interface AgentSkillsServiceLike {
  getLoadedSkills(): Array<{
    slug: string;
    name: string;
    description: string;
  }>;
  getSkillInstructions(
    slug: string,
  ): { slug: string; body: string; estimatedTokens: number } | null;
}
