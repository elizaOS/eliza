import type { Plugin } from "@elizaos/core";
import {
    compareProjectsAction,
    compareSpecificProjectsAction,
    getAllProjects,
    getFilteredProjects,
    getProjectDetail,
    readCSVFile,
} from "./actions";

export * as actions from "./actions";

export const qaccPlugin: Plugin = {
    name: "qacc",
    description: "Agent bootstrap with basic actions and evaluators",
    actions: [
        getAllProjects,
        getProjectDetail,
        compareProjectsAction,
        compareSpecificProjectsAction,
        readCSVFile,
        getFilteredProjects,
    ],
    evaluators: [],
    providers: [],
};
export default qaccPlugin;
