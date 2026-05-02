/**
 * Search Skills Action
 *
 * Searches the skill registry and returns results enriched with structured
 * action chips so the UI can render Enable/Disable/Use/Copy/Install buttons
 * per result, and the LLM can suggest the right follow-up action by name.
 */

import type {
  Action,
  ActionResult,
  HandlerCallback,
  IAgentRuntime,
  Memory,
  State,
} from "@elizaos/core";
import type { AgentSkillsService } from "../services/skills";
import type { SkillSearchResult } from "../types";
import { createAgentSkillsActionValidator } from "./validators";

export type SkillResultActionKind =
  | "use"
  | "enable"
  | "disable"
  | "install"
  | "uninstall"
  | "copy"
  | "details";

export interface SkillResultAction {
  kind: SkillResultActionKind;
  label: string;
  target: string;
}

export type SkillSearchInstalledState = "enabled" | "disabled" | "not-installed";

export interface SkillSearchResultWithActions extends SkillSearchResult {
  installed: boolean;
  enabled: boolean;
  state: SkillSearchInstalledState;
  actions: SkillResultAction[];
}

function buildResultActions(
  slug: string,
  state: SkillSearchInstalledState,
): SkillResultAction[] {
  const detailsAction: SkillResultAction = {
    kind: "details",
    label: "View details",
    target: slug,
  };
  const copyAction: SkillResultAction = {
    kind: "copy",
    label: "Copy SKILL.md",
    target: slug,
  };

  switch (state) {
    case "enabled":
      return [
        { kind: "use", label: "Use", target: slug },
        { kind: "disable", label: "Disable", target: slug },
        copyAction,
        detailsAction,
      ];
    case "disabled":
      return [
        { kind: "enable", label: "Enable", target: slug },
        copyAction,
        detailsAction,
        { kind: "uninstall", label: "Uninstall", target: slug },
      ];
    case "not-installed":
      return [
        { kind: "install", label: "Install", target: slug },
        detailsAction,
      ];
  }
}

function describeChips(actions: SkillResultAction[]): string {
  // Mention the action verbs so an LLM rendering this output can pick the
  // right follow-up action by name (e.g. ENABLE_SKILL, USE_SKILL).
  const map: Record<SkillResultActionKind, string> = {
    use: "USE_SKILL",
    enable: "ENABLE_SKILL",
    disable: "DISABLE_SKILL",
    install: "INSTALL_SKILL",
    uninstall: "UNINSTALL_SKILL",
    copy: "Copy SKILL.md",
    details: "GET_SKILL_DETAILS",
  };
  return actions.map((a) => map[a.kind]).join(" · ");
}

export const searchSkillsAction: Action = {
  name: "SEARCH_SKILLS",
  similes: ["BROWSE_SKILLS", "LIST_SKILLS", "FIND_SKILLS"],
  description:
    "Search the skill registry for available skills by keyword or category. Returns each result with action chips (use/enable/disable/install/copy/details).",
  descriptionCompressed: "Search skill registry; returns action chips per result.",
  validate: createAgentSkillsActionValidator({
    keywords: ["search", "find", "browse", "list", "skill"],
    regex: /\b(?:search|find|browse|list)\b.*\bskills?\b|\bskills?\b.*\b(?:search|find|browse|list)\b/i,
  }),

  handler: async (
    runtime: IAgentRuntime,
    message: Memory,
    _state: State | undefined,
    _options: unknown,
    callback?: HandlerCallback,
  ): Promise<ActionResult> => {
    const service = runtime.getService<AgentSkillsService>(
      "AGENT_SKILLS_SERVICE",
    );
    if (!service) {
      const errorText = "AgentSkillsService not available.";
      if (callback) await callback({ text: errorText });
      return { success: false, error: new Error(errorText) };
    }

    const query = message.content?.text || "";
    const results = await service.search(query, 10);

    if (results.length === 0) {
      const text = `No skills found matching "${query}".`;
      if (callback) await callback({ text });
      return {
        success: true,
        text,
        data: { results: [] as SkillSearchResultWithActions[] },
      };
    }

    const enriched: SkillSearchResultWithActions[] = results.map((r) => {
      const loaded = service.getLoadedSkill(r.slug);
      const installed = Boolean(loaded);
      const enabled = installed && service.isSkillEnabled(r.slug);
      const state: SkillSearchInstalledState = !installed
        ? "not-installed"
        : enabled
          ? "enabled"
          : "disabled";
      return {
        ...r,
        installed,
        enabled,
        state,
        actions: buildResultActions(r.slug, state),
      };
    });

    const skillList = enriched
      .map((r, i) => {
        const stateBadge =
          r.state === "enabled"
            ? "[on]"
            : r.state === "disabled"
              ? "[off]"
              : "[not installed]";
        const chips = describeChips(r.actions);
        return (
          `${i + 1}. **${r.displayName}** (\`${r.slug}\`) ${stateBadge}\n` +
          `   ${r.summary}\n` +
          `   → ${chips}`
        );
      })
      .join("\n\n");

    const text =
      `## Skills matching "${query}"\n\n` +
      `${skillList}\n\n` +
      `Use USE_SKILL with a slug to invoke an enabled skill, ENABLE_SKILL/DISABLE_SKILL to toggle, or INSTALL_SKILL to add a new one.`;

    if (callback) await callback({ text });

    return {
      success: true,
      text,
      data: { results: enriched },
    };
  },

  examples: [
    [
      {
        name: "{{userName}}",
        content: { text: "Search for skills about data analysis" },
      },
      {
        name: "{{agentName}}",
        content: {
          text:
            '## Skills matching "data analysis"\n\n1. **Data Analysis** (`data-analysis`) [not installed]\n   Analyze datasets and generate insights\n   → INSTALL_SKILL · GET_SKILL_DETAILS',
          actions: ["SEARCH_SKILLS"],
        },
      },
    ],
  ],
};

export default searchSkillsAction;
