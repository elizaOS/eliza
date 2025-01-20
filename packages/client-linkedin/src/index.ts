import { Client, elizaLogger, IAgentRuntime } from "@elizaos/core";
import { validateConfig } from "./helpers/validate-config";
import axios from "axios";
import { LinkedInUserInfoFetcher } from "./services/LinkedinUserInfoFetcher";
import { PostsManager } from "./services/PostsManager";

const LINKEDIN_API_URL = "https://api.linkedin.com";

export const LinkedInClient: Client = {
    async start(runtime: IAgentRuntime) {
        const envs = validateConfig(runtime);

        const axiosInstance = axios.create({
            baseURL: LINKEDIN_API_URL,
            headers: {
                "Authorization": `Bearer ${envs.LINKEDIN_ACCESS_TOKEN}`,
            },
        });

        const postManager = await PostsManager.create({
            axiosInstance,
            userInfoFetcher: new LinkedInUserInfoFetcher(axiosInstance),
            runtime,
            config: {
                LINKEDIN_DRY_RUN: envs.LINKEDIN_DRY_RUN,
                LINKEDIN_POST_INTERVAL_MIN: envs.LINKEDIN_POST_INTERVAL_MIN,
                LINKEDIN_POST_INTERVAL_MAX: envs.LINKEDIN_POST_INTERVAL_MAX,
            }
        });
        postManager.createPostPublicationLoop();


        return this;
    },

    async stop(_runtime: IAgentRuntime) {
        elizaLogger.warn("LinkedIn client does not support stopping yet");
    },
};

export default LinkedInClient;
