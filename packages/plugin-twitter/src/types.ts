import type { ClientInstance } from "@elizaos/core";
import type { ClientBase } from "./base";
import type { TwitterInteractionClient } from "./interactions";
import type { TwitterPostClient } from "./post";
import type { TwitterSpaceClient } from "./spaces";

export type MediaData = {
    data: Buffer;
    mediaType: string;
};

export interface ActionResponse {
    like: boolean;
    retweet: boolean;
    quote?: boolean;
    reply?: boolean;
}

export interface ITwitterClient extends ClientInstance {
    client: ClientBase;
    post: TwitterPostClient;
    interaction: TwitterInteractionClient;
    space?: TwitterSpaceClient;
}