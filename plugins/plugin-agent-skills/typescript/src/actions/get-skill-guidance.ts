/**
 * Get Skill Guidance Action
 *
 * Main action for skill-powered assistance. When the agent needs
 * guidance on how to do something, this action:
 *
 * 1. Checks if a matching skill is already installed (fast)
 * 2. If not, searches the registry for a relevant skill
 * 3. Auto-installs the best match if found
 * 4. Returns the skill instructions
 *
 * This provides seamless access to the entire skill library without
 * requiring manual search or installation.
 */

import type {
  Action,
  IAgentRuntime,
  Memory,
  State,
  HandlerCallback,
  ActionResult,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import type { Skill } from "../types";

export const getSkillGuidanceAction: Action = {
  name: "GET_SKILL_GUIDANCE",
  similes: [
    "FIND_SKILL",
    "SEARCH_SKILLS",
    "SKILL_HELP",
    "HOW_TO",
    "GET_INSTRUCTIONS",
    "LEARN_SKILL",
    "LOOKUP_SKILL",
  ],
  description:
    "Search for and get skill instructions. Use when user asks to find a skill or when you need instructions for a capability.",

  validate: async (
    runtime: IAgentRuntime,
    _message: Memory,
  ): Promise<boolean> => {
    const service = await runtime.getService<AgentSkillsService>(
      "AGENT_SKILLS_SERVICE",
    );
    return !!service;
  },

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    try {
      const service = await runtime.getService<AgentSkillsService>(
        "AGENT_SKILLS_SERVICE",
      );
      if (!service) {
        throw new Error("AgentSkillsService not available");
      }

      const query = message.content?.text || "";
      if (!query || query.length < 3) {
        return { success: false, error: new Error("Query too short") };
      }

      // Extract meaningful search terms
      const searchTerms = extractSearchTerms(query);
      runtime.logger.info(`AgentSkills: Searching for "${searchTerms}"`);

      // Step 1: Search registry for best match
      const searchResults = await service.search(searchTerms, 5);

      // Step 2: Check installed skills
      const installedSkills = service.getLoadedSkills();
      const localMatch = findBestLocalMatch(installedSkills, searchTerms);

      runtime.logger.info(
        `AgentSkills: Found ${searchResults.length} remote results, local match: ${localMatch?.skill.slug || "none"} (score: ${localMatch?.score || 0})`,
      );

      // Step 3: Decide best option
      const bestRemote = searchResults.length > 0 ? searchResults[0] : null;
      const remoteScore = bestRemote ? bestRemote.score * 100 : 0;
      const localIsStrong = localMatch && localMatch.score >= 8;

      if (!bestRemote || (bestRemote.score < 0.25 && !localIsStrong)) {
        const text = `I couldn't find a specific skill for "${searchTerms}". I'll do my best with my general knowledge.`;
        if (callback) await callback({ text });
        return {
          success: true,
          text,
          data: { found: false, query: searchTerms },
        };
      }

      // Prefer remote if confident, unless local is a strong name match
      const useLocal =
        localIsStrong && (!bestRemote || localMatch!.score >= remoteScore);

      if (useLocal && localMatch) {
        runtime.logger.info(
          `AgentSkills: Using local skill "${localMatch.skill.slug}"`,
        );
        const instructions = service.getSkillInstructions(
          localMatch.skill.slug,
        );
        return buildSuccessResult(
          localMatch.skill,
          instructions?.body || null,
          "local",
          callback,
        );
      }

      if (!bestRemote) {
        const text = `I couldn't find a specific skill for "${searchTerms}".`;
        if (callback) await callback({ text });
        return { success: true, text, data: { found: false } };
      }

      // Step 4: Auto-install the best remote skill
      const alreadyInstalled = service.getLoadedSkill(bestRemote.slug);

      if (!alreadyInstalled) {
        const installed = await service.install(bestRemote.slug);
        if (!installed) {
          if (localMatch) {
            const instructions = service.getSkillInstructions(
              localMatch.skill.slug,
            );
            return buildSuccessResult(
              localMatch.skill,
              instructions?.body || null,
              "local",
              callback,
            );
          }
          const text = `Found "${bestRemote.displayName}" skill but couldn't install it.`;
          if (callback) await callback({ text });
          return {
            success: true,
            text,
            data: { found: true, installed: false },
          };
        }
      }

      // Step 5: Return the installed skill's instructions
      const skill = service.getLoadedSkill(bestRemote.slug);
      const instructions = skill
        ? service.getSkillInstructions(skill.slug)
        : null;

      return buildSuccessResult(
        skill || {
          slug: bestRemote.slug,
          name: bestRemote.displayName,
          description: bestRemote.summary,
          version: bestRemote.version,
          frontmatter: {
            name: bestRemote.slug,
            description: bestRemote.summary,
          },
          content: "",
          path: "",
          scripts: [],
          references: [],
          assets: [],
          loadedAt: Date.now(),
        },
        instructions?.body || null,
        alreadyInstalled ? "local" : "installed",
        callback,
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      if (callback) {
        await callback({ text: `Error finding skill guidance: ${errorMsg}` });
      }
      return {
        success: false,
        error: error instanceof Error ? error : new Error(errorMsg),
      };
    }
  },

  examples: [
    [
      { name: "{{userName}}", content: { text: "How do I work with PDFs?" } },
      {
        name: "{{agentName}}",
        content: {
          text: "I found the **PDF Processing** skill. Here's how to use it:\n\n# PDF Processing\n\nExtract text and tables from PDF files...",
          actions: ["GET_SKILL_GUIDANCE"],
        },
      },
    ],
    [
      {
        name: "{{userName}}",
        content: { text: "I need help with browser automation" },
      },
      {
        name: "{{agentName}}",
        content: {
          text: "I found the **Browser Automation** skill. Here's the guidance:\n\n# Browser Automation\n\nAutomate browser interactions...",
          actions: ["GET_SKILL_GUIDANCE"],
        },
      },
    ],
  ],
};

/**
 * Extract meaningful search terms from a query.
 */
function extractSearchTerms(query: string): string {
  let cleaned = query
    .toLowerCase()
    .replace(/\b(on|in|from|at)\s+(clawhub|registry)\b/g, "")
    .replace(/\b(clawhub|registry)\s+(catalog|platform|site)\b/g, "");

  const stopWords = new Set([
    "search",
    "find",
    "look",
    "for",
    "a",
    "an",
    "the",
    "skill",
    "skills",
    "please",
    "can",
    "you",
    "help",
    "me",
    "with",
    "how",
    "to",
    "do",
    "i",
    "need",
    "want",
    "get",
    "use",
    "using",
    "about",
    "is",
    "are",
    "there",
    "any",
    "some",
    "show",
    "list",
    "give",
    "tell",
    "what",
    "which",
  ]);

  const words = cleaned
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !stopWords.has(w));

  return words.join(" ") || query.toLowerCase();
}

/**
 * Find the best matching skill from installed skills.
 */
function findBestLocalMatch(
  skills: Skill[],
  query: string,
): { skill: Skill; score: number } | null {
  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter((w) => w.length > 2);
  let bestMatch: { skill: Skill; score: number } | null = null;

  for (const skill of skills) {
    let score = 0;
    const slugLower = skill.slug.toLowerCase();
    const nameLower = skill.name.toLowerCase();

    // Exact slug match in query
    if (
      queryLower.includes(slugLower) ||
      queryWords.some((w) => slugLower.includes(w) && w.length > 3)
    ) {
      score += 10;
    }

    // Name match
    if (
      queryLower.includes(nameLower) ||
      queryWords.some((w) => nameLower.includes(w) && w.length > 3)
    ) {
      score += 8;
    }

    // Description words (selective)
    const genericWords = new Set([
      "skill",
      "agent",
      "search",
      "install",
      "use",
      "when",
      "with",
      "from",
      "your",
    ]);
    const descWords = skill.description.toLowerCase().split(/\s+/);
    for (const word of descWords) {
      if (
        word.length > 5 &&
        !genericWords.has(word) &&
        queryWords.includes(word)
      ) {
        score += 1;
      }
    }

    if (score > 0 && (!bestMatch || score > bestMatch.score)) {
      bestMatch = { skill, score };
    }
  }

  return bestMatch;
}

/**
 * Build a success result with skill instructions.
 */
async function buildSuccessResult(
  skill: Skill,
  instructions: string | null,
  source: "local" | "installed",
  callback?: HandlerCallback,
): Promise<ActionResult> {
  let text = `## ${skill.name}\n\n`;

  if (source === "installed") {
    text += `*Skill installed from registry*\n\n`;
  }

  text += `${skill.description}\n\n`;

  if (instructions) {
    const maxLen = 3500;
    const truncated =
      instructions.length > maxLen
        ? instructions.substring(0, maxLen) + "\n\n...[truncated]"
        : instructions;
    text += `### Instructions\n\n${truncated}`;
  }

  if (callback) {
    await callback({ text, actions: ["GET_SKILL_GUIDANCE"] });
  }

  return {
    success: true,
    text,
    values: {
      activeSkill: skill.slug,
      skillName: skill.name,
      skillSource: source,
    },
    data: {
      skill: {
        slug: skill.slug,
        name: skill.name,
        description: skill.description,
      },
      instructions,
      source,
    },
  };
}

export default getSkillGuidanceAction;
