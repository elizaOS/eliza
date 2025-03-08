import type { TwitterService } from ".";
import type { ClientBase } from "./base";
import type { TwitterInteractionClient } from "./interactions";
import type { TwitterPostClient } from "./post";
import type { TwitterSpaceClient } from "./spaces";

/**
 * Defines a type for media data, which includes a Buffer representing the actual data
 * and a mediaType string indicating the type of media.
 *
 * @typedef {Object} MediaData
 * @property {Buffer} data - The Buffer representing the actual media data.
 * @property {string} mediaType - The type of media (e.g. image, video).
 */
export type MediaData = {
	data: Buffer;
	mediaType: string;
};

/**
 * Interface representing the response from an action.
 * @typedef {Object} ActionResponse
 * @property {boolean} like - Indicates if the action is a like.
 * @property {boolean} retweet - Indicates if the action is a retweet.
 * @property {boolean=} quote - Indicates if the action is a quote. (optional)
 * @property {boolean=} reply - Indicates if the action is a reply. (optional)
 */
export interface ActionResponse {
	like: boolean;
	retweet: boolean;
	quote?: boolean;
	reply?: boolean;
}

/**
 * Interface for a Twitter client.
 * 
 * @property {ClientBase} client - The base client for making requests.
 * @property {TwitterPostClient} post - The client for posting on Twitter.
 * @property {TwitterInteractionClient} interaction - The client for interacting with tweets.
 * @property {TwitterSpaceClient} [space] - The client for managing Twitter spaces (optional).
 * @property {TwitterService} service - The service provider for Twitter API.
 */
export interface ITwitterClient {
	client: ClientBase;
	post: TwitterPostClient;
	interaction: TwitterInteractionClient;
	space?: TwitterSpaceClient;
	service: TwitterService;
}

export const ServiceTypes = {
	TWITTER: "twitter",
} as const;
