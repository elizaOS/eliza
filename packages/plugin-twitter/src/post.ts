import {
	ChannelType,
	type Content,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	type MessagePayload,
	ModelTypes,
	type UUID,
	composePrompt,
	createUniqueUuid,
	logger,
	parseJSONObjectFromText,
	truncateToCompleteSentence
} from "@elizaos/core";
import type { ClientBase } from "./base";
import type { Tweet } from "./client/index";
import { twitterPostTemplate } from "./templates";
import type { MediaData } from "./types";
import { fetchMediaData } from "./utils";

/**
 * Class representing a Twitter post client for generating and posting tweets.
 */
export class TwitterPostClient {
	client: ClientBase;
	runtime: IAgentRuntime;
	twitterUsername: string;
	private isDryRun: boolean;
	private state: any;

	/**
	 * Constructor for initializing a new Twitter client with the provided client, runtime, and state
	 * @param {ClientBase} client - The client used for interacting with Twitter API
	 * @param {IAgentRuntime} runtime - The runtime environment for the agent
	 * @param {any} state - The state object containing configuration settings
	 */
	constructor(client: ClientBase, runtime: IAgentRuntime, state: any) {
		this.client = client;
		this.state = state;
		this.runtime = runtime;
		this.twitterUsername =
			state?.TWITTER_USERNAME ||
			(this.runtime.getSetting("TWITTER_USERNAME") as string);
		this.isDryRun =
			this.state?.TWITTER_DRY_RUN ||
			(this.runtime.getSetting("TWITTER_DRY_RUN") as unknown as boolean);

		// Log configuration on initialization
		logger.log("Twitter Client Configuration:");
		logger.log(`- Username: ${this.twitterUsername}`);
		logger.log(`- Dry Run Mode: ${this.isDryRun ? "Enabled" : "Disabled"}`);

		logger.log(
			`- Disable Post: ${this.state?.TWITTER_ENABLE_POST_GENERATION || this.runtime.getSetting("TWITTER_ENABLE_POST_GENERATION") ? "disabled" : "enabled"}`,
		);

		logger.log(
			`- Post Interval: ${this.state?.TWITTER_POST_INTERVAL_MIN || this.runtime.getSetting("TWITTER_POST_INTERVAL_MIN")}-${this.state?.TWITTER_POST_INTERVAL_MAX || this.runtime.getSetting("TWITTER_POST_INTERVAL_MAX")} minutes`,
		);
		logger.log(
			`- Post Immediately: ${
				this.state?.TWITTER_POST_IMMEDIATELY ||
				this.runtime.getSetting("TWITTER_POST_IMMEDIATELY")
					? "enabled"
					: "disabled"
			}`,
		);

		if (this.isDryRun) {
			logger.log(
				"Twitter client initialized in dry run mode - no actual tweets should be posted",
			);
		}
	}

	/**
	 * Starts the Twitter post client, setting up a loop to periodically generate new tweets.
	 */
	async start() {
		logger.log("Starting Twitter post client...");
		const tweetGeneration = this.runtime.getSetting("TWITTER_ENABLE_TWEET_GENERATION");
		if (tweetGeneration === false) {
			logger.log("Tweet generation is disabled");
			return;
		}

		const generateNewTweetLoop = async () => {
			// Defaults to 30 minutes
			const interval =
				(this.state?.TWITTER_POST_INTERVAL ||
					(this.runtime.getSetting("TWITTER_POST_INTERVAL") as unknown as number) ||
					30) * 60 * 1000;

			this.generateNewTweet();
			setTimeout(generateNewTweetLoop, interval);
		};

		// Start the loop after a 1 minute delay to allow other services to initialize
		setTimeout(generateNewTweetLoop, 60 * 1000);
	}

	/**
	 * Creates a Tweet object based on the tweet result, client information, and Twitter username.
	 *
	 * @param {any} tweetResult - The result object from the Twitter API representing a tweet.
	 * @param {any} client - The client object containing profile information.
	 * @param {string} twitterUsername - The Twitter username of the user.
	 * @returns {Tweet} A Tweet object with specific properties extracted from the tweet result and client information.
	 */
	createTweetObject(
		tweetResult: any,
		client: any,
		twitterUsername: string,
	): Tweet {
		return {
			id: tweetResult.rest_id,
			name: client.profile.screenName,
			username: client.profile.username,
			text: tweetResult.legacy.full_text,
			conversationId: tweetResult.legacy.conversation_id_str,
			createdAt: tweetResult.legacy.created_at,
			timestamp: new Date(tweetResult.legacy.created_at).getTime(),
			userId: client.profile.id,
			inReplyToStatusId: tweetResult.legacy.in_reply_to_status_id_str,
			permanentUrl: `https://twitter.com/${twitterUsername}/status/${tweetResult.rest_id}`,
			hashtags: [],
			mentions: [],
			photos: [],
			thread: [],
			urls: [],
			videos: [],
		} as Tweet;
	}

	/**
	 * Processes and caches a tweet.
	 *
	 * @param {IAgentRuntime} runtime - The agent runtime.
	 * @param {ClientBase} client - The client object.
	 * @param {Tweet} tweet - The tweet to be processed and cached.
	 * @param {UUID} roomId - The ID of the room where the tweet will be stored.
	 * @param {string} rawTweetContent - The raw content of the tweet.
	 */
	async processAndCacheTweet(
		runtime: IAgentRuntime,
		client: ClientBase,
		tweet: Tweet,
		roomId: UUID,
		rawTweetContent: string,
	) {
		// Cache the last post details
		await runtime.setCache<any>(`twitter/${client.profile.username}/lastPost`, {
				id: tweet.id,
				timestamp: Date.now(),
			});

		// Cache the tweet
		await client.cacheTweet(tweet);

		// Log the posted tweet
		logger.log(`Tweet posted:\n ${tweet.permanentUrl}`);

		// Ensure the room and participant exist
		await runtime.ensureRoomExists({
			id: roomId,
			name: "Twitter Feed",
			source: "twitter",
			type: ChannelType.FEED,
		});
		await runtime.ensureParticipantInRoom(runtime.agentId, roomId);

		// Create a memory for the tweet
		await runtime.getMemoryManager("messages").createMemory({
			id: createUniqueUuid(this.runtime, tweet.id),
			entityId: runtime.agentId,
			agentId: runtime.agentId,
			content: {
				text: rawTweetContent.trim(),
				url: tweet.permanentUrl,
				source: "twitter",
			},
			roomId,
			createdAt: tweet.timestamp,
		});
	}

	/**
	 * Handles sending a note tweet with optional media data.
	 *
	 * @param {ClientBase} client - The client object used for sending the note tweet.
	 * @param {string} content - The content of the note tweet.
	 * @param {string} [tweetId] - Optional Tweet ID to reply to.
	 * @param {MediaData[]} [mediaData] - Optional media data to attach to the note tweet.
	 * @returns {Promise<Object>} - The result of the note tweet operation.
	 * @throws {Error} - If the note tweet operation fails.
	 */
	async handleNoteTweet(
		client: ClientBase,
		content: string,
		tweetId?: string,
		mediaData?: MediaData[],
	) {
		try {
			const noteTweetResult = await client.requestQueue.add(
				async () =>
					await client.twitterClient.sendNoteTweet(content, tweetId, mediaData),
			);

			if (noteTweetResult.errors && noteTweetResult.errors.length > 0) {
				// Note Tweet failed due to authorization. Falling back to standard Tweet.
				const truncateContent = truncateToCompleteSentence(content, 280 - 1);
				return await this.sendStandardTweet(client, truncateContent, tweetId);
			}
			return noteTweetResult.data.notetweet_create.tweet_results.result;
		} catch (error) {
			throw new Error(`Note Tweet failed: ${error}`);
		}
	}

	/**
	 * Asynchronously sends a standard tweet using the provided Twitter client.
	 *
	 * @param {ClientBase} client - The client used to make the request.
	 * @param {string} content - The content of the tweet.
	 * @param {string} [tweetId] - Optional tweet ID to reply to.
	 * @param {MediaData[]} [mediaData] - Optional array of media data to attach to the tweet.
	 * @returns {Promise<string>} The result of sending the tweet.
	 */
	async sendStandardTweet(
		client: ClientBase,
		content: string,
		tweetId?: string,
		mediaData?: MediaData[],
	) {
		try {
			const standardTweetResult = await client.requestQueue.add(
				async () =>
					await client.twitterClient.sendTweet(content, tweetId, mediaData),
			);
			const body = await standardTweetResult.json();
			if (!body?.data?.create_tweet?.tweet_results?.result) {
				logger.error("Error sending tweet; Bad response:", body);
				return;
			}
			return body.data.create_tweet.tweet_results.result;
		} catch (error) {
			logger.error("Error sending standard Tweet:", error);
			throw error;
		}
	}

	/**
	 * Posts a new tweet with the provided tweet content and optional media data.
	 *
	 * @param {IAgentRuntime} runtime - The runtime environment for the agent.
	 * @param {ClientBase} client - The Twitter client used to post the tweet.
	 * @param {string} tweetTextForPosting - The text content of the tweet.
	 * @param {UUID} roomId - The ID of the room where the tweet will be posted.
	 * @param {string} rawTweetContent - The raw content of the tweet.
	 * @param {string} twitterUsername - The username associated with the Twitter account.
	 * @param {MediaData[]} [mediaData] - Optional media data to be included in the tweet.
	 * @returns {Promise<void>} - A Promise that resolves when the tweet is successfully posted.
	 */
	async postTweet(
		runtime: IAgentRuntime,
		client: ClientBase,
		tweetTextForPosting: string,
		roomId: UUID,
		rawTweetContent: string,
		twitterUsername: string,
		mediaData?: MediaData[],
	) {
		try {
			logger.log("Posting new tweet:\n");

			let result;

			if (tweetTextForPosting.length > 280 - 1) {
				result = await this.handleNoteTweet(
					client,
					tweetTextForPosting,
					undefined,
					mediaData,
				);
			} else {
				result = await this.sendStandardTweet(
					client,
					tweetTextForPosting,
					undefined,
					mediaData,
				);
			}
			const tweet = this.createTweetObject(result, client, twitterUsername);

			await this.processAndCacheTweet(
				runtime,
				client,
				tweet,
				roomId,
				rawTweetContent,
			);
		} catch (error) {
			logger.error("Error sending tweet:");
			throw error;
		}
	}

	/**
	 * Handles the creation and posting of a tweet by emitting standardized events.
	 * This approach aligns with our platform-independent architecture.
	 */
	async generateNewTweet() {
		try {
			logger.log("Generating new tweet...");
			
			// Create the timeline room ID for storing the post
			const userId = this.client.profile?.id;
			if (!userId) {
				logger.error("Cannot generate tweet: Twitter profile not available");
				return;
			}
			
			const worldId = createUniqueUuid(this.runtime, userId) as UUID;
			const timelineRoomId = createUniqueUuid(this.runtime, `${userId}-home`) as UUID;
			
			// Compose state with relevant context for tweet generation
			const state = await this.runtime.composeState(null, [
				"CHARACTER",
				"RECENT_MESSAGES",
				"TIME",
			]);
			
			// Generate prompt for tweet content
			const tweetPrompt = composePrompt({
				state,
				template: this.runtime.character.templates?.twitterPostTemplate || twitterPostTemplate,
			});
			
			const response = await this.runtime.useModel(ModelTypes.TEXT_LARGE, {
				prompt: tweetPrompt,
			});
			
			// Extract the tweet content from the model response
			const jsonResponse = parseJSONObjectFromText(response);
			
			if (!jsonResponse || !jsonResponse.text) {
				logger.error("Failed to generate valid tweet content");
				return;
			}
			
			// Cleanup the tweet text
			const cleanedText = this.cleanupTweetText(jsonResponse.text);
			
			// Prepare media if included
			const mediaData: MediaData[] = [];
			if (jsonResponse.imagePrompt) {
				try {
					// Convert image prompt to Media format for fetchMediaData
					const imagePromptMedia: any[] = Array.isArray(jsonResponse.imagePrompt) 
						? jsonResponse.imagePrompt.map((prompt: string) => ({ 
							url: prompt, 
							contentType: 'image/png' 
						}))
						: [{ 
							url: jsonResponse.imagePrompt, 
							contentType: 'image/png' 
						}];
					
					// Fetch media using the utility function
					const fetchedMedia = await fetchMediaData(imagePromptMedia);
					mediaData.push(...fetchedMedia);
				} catch (error) {
					logger.error("Error fetching media for tweet:", error);
				}
			}
			
			// Create the memory object for the tweet
			const tweetId = createUniqueUuid(this.runtime, `tweet-${Date.now()}`) as UUID;
			const memory: Memory = {
				id: tweetId,
				entityId: this.runtime.agentId,
				agentId: this.runtime.agentId,
				roomId: timelineRoomId,
				content: {
					text: cleanedText,
					source: "twitter",
					channelType: ChannelType.FEED,
					thought: jsonResponse.thought || "",
					plan: jsonResponse.plan || "",
					type: "post",
				},
				createdAt: Date.now(),
			};
			
			// Create a callback for handling the actual posting
			const callback: HandlerCallback = async (content: Content) => {
				try {
					if (this.isDryRun) {
						logger.info(`[DRY RUN] Would post tweet: ${content.text}`);
						return [];
					}
					
					// Post the tweet
					const result = await this.postToTwitter(content.text, mediaData);
					
					if (result) {
						const postedTweetId = createUniqueUuid(
							this.runtime,
							(result as any).id_str
						);
						
						// Create memory for the posted tweet
						const postedMemory: Memory = {
							id: postedTweetId,
							entityId: this.runtime.agentId,
							agentId: this.runtime.agentId,
							roomId: timelineRoomId,
							content: {
								...content,
								source: "twitter",
								channelType: ChannelType.FEED,
								type: "post",
								metadata: {
									tweetId: (result as any).id_str,
									postedAt: Date.now(),
								},
							},
							createdAt: Date.now(),
						};
						
						await this.runtime
							.getMemoryManager("messages")
							.createMemory(postedMemory);
							
						return [postedMemory];
					}
					
					return [];
				} catch (error) {
					logger.error("Error posting tweet:", error);
					return [];
				}
			};
			
			// Emit event to handle the post generation using standard handlers
			this.runtime.emitEvent(["TWITTER_POST_GENERATED", "POST_GENERATED"], {
				runtime: this.runtime,
				message: memory,
				callback,
				source: "twitter"
			} as MessagePayload);
			
		} catch (error) {
			logger.error("Error generating tweet:", error);
		}
	}
	
	/**
	 * Posts content to Twitter
	 * @param {string} text The tweet text to post
	 * @param {MediaData[]} mediaData Optional media to attach to the tweet
	 * @returns {Promise<any>} The result from the Twitter API
	 */
	private async postToTwitter(text: string, mediaData: MediaData[] = []): Promise<any> {
		try {
			// Handle media uploads if needed
			const mediaIds: string[] = [];
			
			if (mediaData && mediaData.length > 0) {
				for (const media of mediaData) {
					try {
						// Upload the media and get the media ID
						const uploadResult = await this.client.requestQueue.add(() =>
							(this.client.twitterClient as any).post("media/upload", {
								media_data: Buffer.isBuffer(media.data) 
									? media.data 
									: Buffer.from(String(media.data).split(",")[1], 'base64')
							})
						);
						
						if (uploadResult && (uploadResult as any).media_id_string) {
							mediaIds.push((uploadResult as any).media_id_string);
						}
					} catch (error) {
						logger.error("Error uploading media:", error);
					}
				}
			}
			
			// Prepare the tweet parameters
			const tweetParams: any = {
				status: text.substring(0, 280), // Twitter's character limit
			};
			
			// Add media if available
			if (mediaIds.length > 0) {
				tweetParams.media_ids = mediaIds.join(",");
			}
			
			// Post the tweet
			const result = await this.client.requestQueue.add(() =>
				(this.client.twitterClient as any).post("statuses/update", tweetParams)
			);
			
			return result;
		} catch (error) {
			logger.error("Error posting to Twitter:", error);
			throw error;
		}
	}
	
	/**
	 * Cleans up a tweet text by removing quotes and fixing newlines
	 */
	private cleanupTweetText(text: string): string {
		// Remove quotes
		let cleanedText = text.replace(/^['"](.*)['"]$/, "$1");
		// Fix newlines
		cleanedText = cleanedText.replaceAll(/\\n/g, "\n\n");
		// Truncate to Twitter's character limit (280)
		if (cleanedText.length > 280) {
			cleanedText = truncateToCompleteSentence(cleanedText, 280);
		}
		return cleanedText;
	}

	async stop() {
		// Implement stop functionality if needed
	}
}
