import type { IAgentRuntime, Memory, Provider, State } from "@elizaos/core";
import axios from "axios";

import { validateDiscourseConfig } from "../enviroment";

interface Post {
    id: number;
    name: string;
    username: string;
    avatar_template: string;
    created_at: string;
    cooked: string;
    post_number: number;
    post_type: number;
    updated_at: string;
    reply_count: number;
    reply_to_post_number: string | null;
    quote_count: number;
    incoming_link_count: number;
    reads: number;
    readers_count: number;
    score: number;
    yours: boolean;
    topic_id: number;
    topic_slug: string;
    topic_title: string;
    topic_html_title: string;
    category_id: number;
    display_username: string;
    primary_group_name: null | string;
    flair_name: null | string;
    flair_url: null | string;
    flair_bg_color: null | string;
    flair_color: null | string;
    flair_group_id: null | number;
    badges_granted: any[];
    version: number;
    can_edit: boolean;
    can_delete: boolean;
    can_recover: boolean;
    can_see_hidden_post: boolean;
    can_wiki: boolean;
    user_title: null | string;
    bookmarked: boolean;
    raw: string;
    actions_summary: any[];
    moderator: boolean;
    admin: boolean;
    staff: boolean;
    user_id: number;
    hidden: boolean;
    trust_level: number;
    deleted_at: null | string;
    user_deleted: boolean;
    edit_reason: null | string;
    can_view_edit_history: boolean;
    wiki: boolean;
    user_cakedate: string;
    can_accept_answer: boolean;
    can_unaccept_answer: boolean;
    accepted_answer: boolean;
    topic_accepted_answer: boolean;
}

function formatLatestPostsData(posts: Post[]) {
    return posts
        .map((post) => {
            return `Post ID: ${post.id}\nCreated At: ${post.created_at}\nUsername: ${post.username}\nRaw: ${post.raw}\n\n`;
        })
        .join("");
}

const discourseProvider: Provider = {
    get: async (
        runtime: IAgentRuntime,
        _message: Memory,
        _state?: State,
    ): Promise<string | null> => {
        try {
            // Extract and validate the Discourse configuration from the runtime context
            const config = await validateDiscourseConfig(runtime);

            // Removing any trailing slash on the instance URL
            const trimmedInstanceUrl = config.DISCOURSE_INSTANCE_URL.replace(
                /\/$/,
                "",
            );

            // Make the API call to get the latest posts
            // In the next iteration, we can allow users to request more than just posts
            const response = await axios.get(`${trimmedInstanceUrl}/posts`, {
                headers: {
                    accept: "application/json",
                },
            });
            const posts = response.data;

            if (
                !posts.latest_posts ||
                !posts.latest_posts.length ||
                posts.latest_posts.length === 0
            ) {
                return "No post data found - report this to the user.";
            }

            return formatLatestPostsData(posts.latest_posts as Post[]);
        } catch (error) {
            console.error("Error in discourse provider:", error);
            return "Error interacting with Discourse instance - report this to the user.";
        }
    },
};

// Module exports
export { discourseProvider };
