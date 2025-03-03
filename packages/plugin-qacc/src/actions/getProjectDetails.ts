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
import { getSingleProjectTemplate } from "../templates";
import { getQACCProjectNameExamples } from "../examples";
import {
    countProjects,
    fetchAllProjects,
    fetchProjectByName,
    fetchProjectBySlug,
} from "../services";
import { generateSummary } from "../helpers/projectHelper";

export const getProjectDetail: Action = {
    name: "GET_QACC_PROJECT_DETAILS",
    similes: [
        "PROJECT_DETAILS",
        "QACC_PROJECT_INFO",
        "PROJECT_INFORMATION",
        "GET_PROJECT_INFO",
        "QACC_PROJECT_DETAILS",
        "FETCH_PROJECT_DETAILS",
        "QACC_PROJECT_OVERVIEW",
        "PROJECT_NAME_INFO",
        "DETAILS_ABOUT_PROJECT",
    ],
    description:
        "Fetch detailed information about a specific QACC project based on the provided project name.",
    validate: async (runtime: IAgentRuntime) => {
        // await validateOpenWeatherConfig(runtime);
        return true;
    },
    handler: async (
        runtime: IAgentRuntime,
        message: Memory,
        state: State,
        _options: { [key: string]: unknown },
        callback: HandlerCallback
    ) => {
        // Initialize/update state
        if (!state) {
            state = (await runtime.composeState(message)) as State;
        }
        state = await runtime.updateRecentMessageState(state);

        // state -> context
        const qaccProjectContext = composeContext({
            state,
            template: getSingleProjectTemplate,
        });

        // context -> content
        const content = await generateMessageResponse({
            runtime,
            context: qaccProjectContext,
            modelClass: ModelClass.SMALL,
        });

        console.log(content, "Context generted");

        // parse content
        const hasProjectName = content?.project_name && !content?.error;

        if (!hasProjectName) {
            return;
        }
        try {
            // const qaccData = await fetchProjectByName(content?.project_name);

            const allProjects = await runtime.cacheManager.get(
                "currentCSVData"
            );
            let qaccData;
            if (Array.isArray(allProjects)) {
                qaccData = allProjects.find(
                    (project) =>
                        project["Project name"] === content?.project_name
                );
            }

            elizaLogger.success(`Successfully fetched qacc project data`);
            console.log(allProjects);

            const summaryResponse = await generateSummary(runtime, state, {
                data: qaccData,
            });

            if (callback) {
                callback({
                    text: summaryResponse?.summary as string,
                    content: summaryResponse,
                    action: state.actionNames,
                });

                return true;
            }
        } catch (error) {
            elizaLogger.error("Error in getting details from DB:", error);

            callback({
                text: `Error fetching data: ${error.message}`,
                content: { error: error.message },
            });

            return false;
        }

        return;
    },
    examples: getQACCProjectNameExamples as ActionExample[][],
} as Action;
