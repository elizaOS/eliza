import { composeContext, elizaLogger } from "@elizaos/core";
import { generateMessageResponse } from "@elizaos/core";
import {
    Action,
    ActionExample,
    HandlerCallback,
    IAgentRuntime,
    Memory,
    ModelClass,
    State,
} from "@elizaos/core";
import { getFilteredProjectsTemplate } from "../templates";
import { getFilteredProjectsExamples } from "../examples";
import { fetchProjectsByConditions } from "../services";

// Define valid filter fields and their mappings
const FILTER_MAPPINGS = {
    token_status: [
        "Yes, provide details",
        "No, we have not launched a token",
        "in_progress",
    ],
    project_stage: [
        "MVP without revenue",
        "Live product ready to scale",
        "MVP with active users and revenue",
        "Product concept with a high-level roadmap",
    ],
    project_category: [
        "defi",
        "nft",
        "gaming",
        "infrastructure",
        "dao",
        "social",
        "other",
    ],
    polygon_deployment: ["deployed", "not_deployed", "in_progress"],
    team_size: "number",
    primary_location: "string",
    legal_entity: ["yes", "no", "in_progress"],
    revenue_status: ["pre_revenue", "revenue_generating", "profitable"],
    funding_status: [
        "bootstrapped",
        "seed_funded",
        "series_a",
        "series_b",
        "not_disclosed",
    ],
    development_timeline: "date",
    other_chains: ["yes", "no", "planned"],
    monthly_burn: "number",
} as const;

interface FilterCondition {
    field: keyof typeof FILTER_MAPPINGS;
    value: string | number | boolean | Date;
    operator?:
        | "equals"
        | "greater_than"
        | "less_than"
        | "contains"
        | "before"
        | "after";
}

export const getFilteredProjects: Action = {
    name: "GET_FILTERED_QACC_PROJECTS",
    similes: [
        "FILTER_PROJECTS",
        "FIND_PROJECTS",
        "SEARCH_PROJECTS",
        "QUERY_PROJECTS",
        "GET_SPECIFIC_PROJECTS",
        "FIND_MATCHING_PROJECTS",
    ],
    description:
        "Fetch QACC projects based on specific conditions or criteria.",
    validate: async (runtime: IAgentRuntime) => {
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        }
        state = await runtime.updateRecentMessageState(state);

        const filteredProjectsContext = composeContext({
            state,
            template: getFilteredProjectsTemplate,
        });

        const content = await generateMessageResponse({
            runtime,
            context: filteredProjectsContext,
            modelClass: ModelClass.SMALL,
        });

        try {
            const conditions = content?.conditions as FilterCondition[];

            if (!conditions || !Array.isArray(conditions)) {
                throw new Error("Invalid filter conditions provided");
            }

            // Validate conditions
            const validatedConditions = conditions.filter((condition) =>
                FILTER_MAPPINGS.hasOwnProperty(condition.field)
            );
            console.log("Conditoins", validatedConditions);
            const allProjects = await runtime.cacheManager.get(
                "currentCSVData"
            );

            const filteredProjects = await fetchProjectsByConditions(
                validatedConditions,
                allProjects
            );
            elizaLogger.success("Successfully fetched filtered QACC projects");

            // Create response table
            let responseText = `Found ${filteredProjects.length} matching projects\n\n`;

            // Dynamic table header based on filtered fields
            const fieldsToDisplay = [
                "Project Name",
                ...validatedConditions.map((c) =>
                    c.field
                        .split("_")
                        .map(
                            (word) =>
                                word.charAt(0).toUpperCase() + word.slice(1)
                        )
                        .join(" ")
                ),
            ];

            callback({
                text: responseText,
                content: {
                    projects: filteredProjects,
                    total: filteredProjects.length,
                    appliedFilters: validatedConditions,
                    formattedTable: responseText,
                },
            });

            return true;
        } catch (error) {
            elizaLogger.error(
                "Error in GET_FILTERED_QACC_PROJECTS handler:",
                error
            );
            callback({
                text: `Error fetching filtered projects: ${error.message}`,
                content: { error: error.message },
            });
            return false;
        }
    },
    examples: getFilteredProjectsExamples as ActionExample[][],
} as Action;
