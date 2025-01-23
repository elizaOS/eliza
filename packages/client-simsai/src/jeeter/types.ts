import { Content } from "@elizaos/core";

export interface ApiError extends Error {
    statusCode?: number;
    endpoint?: string;
}

export type SimsAIProfile = {
    id: string;
    username: string;
    screenName: string;
    bio: string;
};

export interface Agent {
    id: string;
    builder_id: string;
    username: string;
    name: string;
    bio: string;
    avatar_url: string;
    created_at: string;
    updated_at: string;
}

export interface ApiAgent {
    id: string;
    name: string;
    username: string;
    type: string;
    avatar_url: string;
}

export interface Jeet {
    readonly id?: string;
    readonly agentId?: string;
    readonly text?: string;
    readonly createdAt?: string;
    readonly agent?: ApiAgent | Agent;
    readonly public_metrics?: {
        reply_count: number;
        like_count: number;
        quote_count: number;
        rejeet_count: number;
    };
    readonly conversationId?: string;
    readonly hashtags: string[];
    readonly inReplyToStatusId?: string;
    readonly isRejeet?: boolean;
    readonly name?: string;
    readonly mentions: Jeet[];
    readonly permanentUrl?: string;
    readonly photos: Photo[];
    readonly thread: Jeet[];
    readonly timestamp?: number;
    readonly urls: string[];
    readonly userId?: string;
    readonly username?: string;
    readonly videos: Video[];
    media: Array<{
        type: string;
        url: string;
        preview_url?: string;
    }>;
    readonly type?: string;
}

export interface Video {
    id: string;
    preview: string;
    url?: string;
}

export interface Pagination {
    next_cursor: string;
    has_more: boolean;
}

export interface Photo {
    id: string;
    url: string;
    alt_text: string | undefined;
}

export interface JeetInteraction {
    type: "reply" | "like" | "rejeet" | "quote" | "none";
    text?: string;
}

export interface EnhancedResponseContent extends Content {
    text: string;
    shouldLike?: boolean;
    interactions: JeetInteraction[];
    action: ValidAction;
}

export type ValidAction = "CONTINUE" | "END" | "IGNORE";

export interface JeetResponse {
    jeets: Jeet[];
    nextCursor?: string;
}

export interface ApiSearchResponse {
    data: Array<{
        id: string;
        text: string;
        created_at: string;
        author_id: string;
        in_reply_to_status_id?: string;
        public_metrics: {
            reply_count: number;
            like_count: number;
            quote_count: number;
            rejeet_count: number;
        };
    }>;
    includes: {
        users: Array<ApiAgent>;
    };
    meta: {
        result_count: number;
    };
}

export interface ApiConversationResponse {
    data: Array<{
        id: string;
        text: string;
        created_at: string;
        author_id: string;
        in_reply_to_status_id?: string;
        public_metrics: {
            reply_count: number;
            like_count: number;
            quote_count: number;
            rejeet_count: number;
        };
    }>;
    includes: {
        users: Array<ApiAgent>;
    };
}

export interface ApiLikeResponse {
    data: {
        liked: boolean;
    };
}

export interface ApiRejeetResponse {
    data: {
        id: string;
        created_at: string;
        author_id: string;
    };
}

export interface ApiPostJeetResponse {
    data: {
        id: string;
        text: string;
        type: string;
        created_at: string;
        author_id: string;
        public_metrics: {
            reply_count: number;
            like_count: number;
            quote_count: number;
            rejeet_count: number;
        };
    };
    includes: {
        users: Array<ApiAgent>;
        media: Array<{
            type: string;
            url: string;
            preview_url?: string;
        }>;
    };
}
