import {
  type Action,
  type ActionResult,
  type HandlerCallback,
  type HandlerOptions,
  type IAgentRuntime,
  logger,
  type Memory,
  ModelType,
  type State,
} from "@elizaos/core";
import type { Team, User } from "@linear/sdk";
import { listTeamsTemplate } from "../generated/prompts/typescript/prompts.js";
import type { LinearService } from "../services/linear";

interface TeamWithDetails extends Team {
  memberCount?: number;
  projectCount?: number;
  membersList?: User[];
}

export const listTeamsAction: Action = {
  name: "LIST_LINEAR_TEAMS",
  description: "List teams in Linear with optional filters",
  similes: ["list-linear-teams", "show-linear-teams", "get-linear-teams", "view-linear-teams"],

  examples: [
    [
      {
        name: "User",
        content: {
          text: "Show me all teams",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll list all the teams in Linear for you.",
          actions: ["LIST_LINEAR_TEAMS"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Which engineering teams do we have?",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "Let me find the engineering teams for you.",
          actions: ["LIST_LINEAR_TEAMS"],
        },
      },
    ],
    [
      {
        name: "User",
        content: {
          text: "Show me the teams I'm part of",
        },
      },
      {
        name: "Assistant",
        content: {
          text: "I'll show you the teams you're a member of.",
          actions: ["LIST_LINEAR_TEAMS"],
        },
      },
    ],
  ],

  validate: async (runtime: any, message: any, state?: any, options?: any): Promise<boolean> => {
    const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
    const __avText = __avTextRaw.toLowerCase();
    const __avKeywords = ["list", "linear", "teams"];
    const __avKeywordOk =
      __avKeywords.length > 0 &&
      __avKeywords.some((word) => word.length > 0 && __avText.includes(word));
    const __avRegex = /\b(?:list|linear|teams)\b/i;
    const __avRegexOk = __avRegex.test(__avText);
    const __avSource = String(message?.content?.source ?? message?.source ?? "");
    const __avExpectedSource = "";
    const __avSourceOk = __avExpectedSource
      ? __avSource === __avExpectedSource
      : Boolean(
          __avSource || state || runtime?.agentId || runtime?.getService || runtime?.getSetting
        );
    const __avOptions = options && typeof options === "object" ? options : {};
    const __avInputOk =
      __avText.trim().length > 0 ||
      Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
      Boolean(message?.content && typeof message.content === "object");

    if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
      return false;
    }

    const __avLegacyValidate = async (
      runtime: any,
      message: any,
      state?: any,
      options?: any
    ): Promise<boolean> => {
      const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
      const __avText = __avTextRaw.toLowerCase();
      const __avKeywords = ["list", "linear", "teams"];
      const __avKeywordOk =
        __avKeywords.length > 0 &&
        __avKeywords.some((word) => word.length > 0 && __avText.includes(word));
      const __avRegex = /\b(?:list|linear|teams)\b/i;
      const __avRegexOk = __avRegex.test(__avText);
      const __avSource = String(message?.content?.source ?? message?.source ?? "");
      const __avExpectedSource = "";
      const __avSourceOk = __avExpectedSource
        ? __avSource === __avExpectedSource
        : Boolean(
            __avSource || state || runtime?.agentId || runtime?.getService || runtime?.getSetting
          );
      const __avOptions = options && typeof options === "object" ? options : {};
      const __avInputOk =
        __avText.trim().length > 0 ||
        Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
        Boolean(message?.content && typeof message.content === "object");

      if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
        return false;
      }

      const __avLegacyValidate = async (
        runtime: any,
        message: any,
        state?: any,
        options?: any
      ): Promise<boolean> => {
        const __avTextRaw = typeof message?.content?.text === "string" ? message.content.text : "";
        const __avText = __avTextRaw.toLowerCase();
        const __avKeywords = ["list", "linear", "teams"];
        const __avKeywordOk =
          __avKeywords.length > 0 &&
          __avKeywords.some((kw) => kw.length > 0 && __avText.includes(kw));
        const __avRegex = /\b(?:list|linear|teams)\b/i;
        const __avRegexOk = __avRegex.test(__avText);
        const __avSource = String(message?.content?.source ?? message?.source ?? "");
        const __avExpectedSource = "";
        const __avSourceOk = __avExpectedSource
          ? __avSource === __avExpectedSource
          : Boolean(__avSource || state || runtime?.agentId || runtime?.getService);
        const __avOptions = options && typeof options === "object" ? options : {};
        const __avInputOk =
          __avText.trim().length > 0 ||
          Object.keys(__avOptions as Record<string, unknown>).length > 0 ||
          Boolean(message?.content && typeof message.content === "object");

        if (!(__avKeywordOk && __avRegexOk && __avSourceOk && __avInputOk)) {
          return false;
        }

        const __avLegacyValidate = async (
          runtime: IAgentRuntime,
          _message: Memory,
          _state?: State
        ) => {
          const apiKey = runtime.getSetting("LINEAR_API_KEY");
          return !!apiKey;
        };
        try {
          return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
        } catch {
          return false;
        }
      };
      try {
        return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
      } catch {
        return false;
      }
    };
    try {
      return Boolean(await (__avLegacyValidate as any)(runtime, message, state, options));
    } catch {
      return false;
    }
  },

  async handler(
    runtime: IAgentRuntime,
    message: Memory,
    _state?: State,
    _options?: HandlerOptions,
    callback?: HandlerCallback
  ): Promise<ActionResult> {
    try {
      const linearService = runtime.getService<LinearService>("linear");
      if (!linearService) {
        throw new Error("Linear service not available");
      }

      const content = message.content.text || "";
      let nameFilter: string | undefined;
      let specificTeam: string | undefined;
      let myTeams = false;
      let includeDetails = false;

      if (content) {
        const prompt = listTeamsTemplate.replace("{{userMessage}}", content);
        const response = await runtime.useModel(ModelType.TEXT_LARGE, {
          prompt: prompt,
        });

        if (response) {
          try {
            const parsed = JSON.parse(
              response
                .replace(/^```(?:json)?\n?/, "")
                .replace(/\n?```$/, "")
                .trim()
            );

            nameFilter = parsed.nameFilter;
            specificTeam = parsed.specificTeam;
            myTeams = parsed.myTeams === true;
            includeDetails = parsed.includeDetails === true;
          } catch (parseError) {
            logger.warn("Failed to parse team filters:", parseError);
          }
        }
      }

      let teams = await linearService.getTeams();

      if (specificTeam) {
        teams = teams.filter(
          (team) =>
            team.key.toLowerCase() === specificTeam.toLowerCase() ||
            team.name.toLowerCase() === specificTeam.toLowerCase()
        );
      }

      if (nameFilter && !specificTeam) {
        const keywords = nameFilter.toLowerCase().split(/\s+/);
        teams = teams.filter((team) => {
          const teamText = `${team.name} ${team.description || ""}`.toLowerCase();
          return keywords.some((keyword) => teamText.includes(keyword));
        });
      }

      if (myTeams) {
        try {
          const userTeams = await linearService.getUserTeams();
          const userTeamIds = new Set(userTeams.map((t) => t.id));
          teams = teams.filter((team) => userTeamIds.has(team.id));
        } catch (error) {
          logger.warn("Could not filter for user's teams:", error);
        }
      }

      if (teams.length === 0) {
        const noTeamsMessage = specificTeam
          ? `No team found matching "${specificTeam}".`
          : nameFilter
            ? `No teams found matching "${nameFilter}".`
            : "No teams found in Linear.";
        await callback?.({
          text: noTeamsMessage,
          source: message.content.source,
        });
        return {
          text: noTeamsMessage,
          success: true,
          data: {
            teams: [],
          },
        };
      }

      let teamsWithDetails: TeamWithDetails[] = teams;
      if (includeDetails || specificTeam) {
        teamsWithDetails = await Promise.all(
          teams.map(async (team): Promise<TeamWithDetails> => {
            const membersQuery = await team.members();
            const members = await membersQuery.nodes;
            const projectsQuery = await team.projects();
            const projects = await projectsQuery.nodes;

            return Object.assign(team, {
              memberCount: members.length,
              projectCount: projects.length,
              membersList: specificTeam ? members.slice(0, 5) : [],
            });
          })
        );
      }

      const teamList = teamsWithDetails
        .map((team: TeamWithDetails, index: number) => {
          let info = `${index + 1}. ${team.name} (${team.key})`;

          if (team.description) {
            info += `\n   ${team.description}`;
          }

          if (includeDetails || specificTeam) {
            info += `\n   Members: ${team.memberCount ?? 0} | Projects: ${team.projectCount ?? 0}`;

            const membersList = team.membersList ?? [];
            if (specificTeam && membersList.length > 0) {
              const memberNames = membersList.map((m: User) => m.name).join(", ");
              info += `\n   Team members: ${memberNames}${(team.memberCount ?? 0) > 5 ? " ..." : ""}`;
            }
          }

          return info;
        })
        .join("\n\n");

      const headerText =
        specificTeam && teams.length === 1
          ? `📋 Team Details:`
          : nameFilter
            ? `📋 Found ${teams.length} team${teams.length === 1 ? "" : "s"} matching "${nameFilter}":`
            : `📋 Found ${teams.length} team${teams.length === 1 ? "" : "s"}:`;

      const resultMessage = `${headerText}\n\n${teamList}`;
      await callback?.({
        text: resultMessage,
        source: message.content.source,
      });

      return {
        text: `Found ${teams.length} team${teams.length === 1 ? "" : "s"}`,
        success: true,
        data: {
          teams: teamsWithDetails.map((t: TeamWithDetails) => ({
            id: t.id,
            name: t.name,
            key: t.key,
            description: t.description,
            memberCount: t.memberCount,
            projectCount: t.projectCount,
          })),
          count: teams.length,
          filters: {
            name: nameFilter,
            specific: specificTeam,
          },
        },
      };
    } catch (error) {
      logger.error("Failed to list teams:", error);
      const errorMessage = `❌ Failed to list teams: ${error instanceof Error ? error.message : "Unknown error"}`;
      await callback?.({
        text: errorMessage,
        source: message.content.source,
      });
      return {
        text: errorMessage,
        success: false,
      };
    }
  },
};
