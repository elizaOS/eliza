import {
	logger,
	type TestSuite,
	type IAgentRuntime,
	ModelTypes,
	stringToUuid,
	createUniqueUuid,
} from "@elizaos/core";
import type { TwitterClient } from "./index.ts";
import { SearchMode } from "./client/index.ts";
import { fetchMediaData } from "./utils.ts";
import { ServiceTypes } from "./types.ts";

const TEST_IMAGE_URL =
	"https://github.com/elizaOS/awesome-eliza/blob/main/assets/eliza-logo.jpg?raw=true";

const TEST_IMAGE = {
	id: "mock-image-id",
	text: "mock image",
	description: "mock image descirption",
	source: "mock image source",
	url: TEST_IMAGE_URL,
	title: "mock image",
	contentType: "image/jpeg",
	alt_text: "mock image",
};

export class TwitterTestSuite implements TestSuite {
	name = "twitter";
	private twitterClient: TwitterClient | null = null;
	tests: { name: string; fn: (runtime: IAgentRuntime) => Promise<void> }[];

	constructor() {
		this.tests = [
			{
				name: "Initialize Twitter Client",
				fn: this.testInitializingClient.bind(this),
			},
			{ name: "Fetch Profile", fn: this.testFetchProfile.bind(this) },
			{
				name: "Fetch Search Tweets",
				fn: this.testFetchSearchTweets.bind(this),
			},
			{
				name: "Fetch Home Timeline",
				fn: this.testFetchHomeTimeline.bind(this),
			},
			{ name: "Fetch Own Posts", fn: this.testFetchOwnPosts.bind(this) },
			{ name: "Post Tweet", fn: this.testPostTweet.bind(this) },
			{ name: "Post Tweet With Image", fn: this.testPostImageTweet.bind(this) },
			{ name: "Generate New Tweet", fn: this.testGenerateNewTweet.bind(this) },
			{
				name: "Handle Tweet Response",
				fn: this.testHandleTweetResponse.bind(this),
			},
		];
	}

	async testInitializingClient(runtime: IAgentRuntime) {
		try {
			const manager = runtime.getService(ServiceTypes.TWITTER);
			if (!manager) {
				throw new Error("Twitter client manager not found");
			}

			const clientId = stringToUuid("default");
			this.twitterClient = manager.clients.get(
				manager.getClientKey(clientId, runtime.agentId),
			);

			if (this.twitterClient) {
				logger.success("TwitterClient initialized successfully.");
			} else {
				throw new Error("TwitterClient failed to initialize.");
			}
		} catch (error) {
			throw new Error(`Error in initializing Twitter client: ${error}`);
		}
	}

	async testFetchProfile(runtime: IAgentRuntime) {
		try {
			const username = runtime.getSetting("TWITTER_USERNAME") as string;
			const profile = await this.twitterClient.client.fetchProfile(username);
			if (!profile || !profile.id) {
				throw new Error("Profile fetch failed.");
			}
			logger.log("Successfully fetched Twitter profile:", profile);
		} catch (error) {
			throw new Error(`Error fetching Twitter profile: ${error}`);
		}
	}

	async testFetchSearchTweets(_runtime: IAgentRuntime) {
		try {
			const tweets = await this.twitterClient.client.fetchSearchTweets(
				`@${this.twitterClient.client.profile?.username}`,
				5,
				SearchMode.Latest,
			);

			console.log(
				`Successfully fetched ${tweets.tweets.length} search tweets.`,
			);
		} catch (error) {
			throw new Error(`Error fetching search tweets: ${error}`);
		}
	}

	async testFetchHomeTimeline(_runtime: IAgentRuntime) {
		try {
			const timeline = await this.twitterClient.client.fetchHomeTimeline(5);
			if (!timeline || timeline.length === 0) {
				throw new Error("No tweets in home timeline.");
			}
			logger.log(
				`Successfully fetched ${timeline.length} tweets from home timeline.`,
			);
		} catch (error) {
			throw new Error(`Error fetching home timeline: ${error}`);
		}
	}

	async testFetchOwnPosts(_runtime: IAgentRuntime) {
		try {
			const posts = await this.twitterClient.client.fetchOwnPosts(5);
			if (!posts || posts.length === 0) {
				throw new Error("No own posts found.");
			}
			logger.log(`Successfully fetched ${posts.length} own posts.`);
		} catch (error) {
			throw new Error(`Error fetching own posts: ${error}`);
		}
	}

	async testPostTweet(runtime: IAgentRuntime) {
		try {
			const roomId = createUniqueUuid(runtime, "twitter_mock_room");

			const postClient = this.twitterClient.post;
			const tweetText = await this.generateRandomTweetContent(runtime);
			await postClient.postTweet(
				runtime,
				this.twitterClient.client,
				tweetText,
				roomId,
				tweetText,
				"test-username",
			);
			logger.success("Successfully posted a test tweet.");
		} catch (error) {
			throw new Error(`Error posting a tweet: ${error}`);
		}
	}

	async testPostImageTweet(runtime: IAgentRuntime) {
		try {
			const roomId = createUniqueUuid(runtime, "twitter_mock_room");

			const postClient = this.twitterClient.post;
			const tweetText = await this.generateRandomTweetContent(
				runtime,
				"image_post",
			);
			const mediaData = await fetchMediaData([TEST_IMAGE]);
			await postClient.postTweet(
				runtime,
				this.twitterClient.client,
				tweetText,
				roomId,
				tweetText,
				"test-username",
				mediaData,
			);
			logger.success("Successfully posted a test tweet.");
		} catch (error) {
			throw new Error(`Error posting a tweet: ${error}`);
		}
	}

	async testGenerateNewTweet(_runtime: IAgentRuntime) {
		try {
			const postClient = this.twitterClient.post;
			await postClient.generateNewTweet();
			logger.success("Successfully generated a new tweet.");
		} catch (error) {
			throw new Error(`Error generating new tweet: ${error}`);
		}
	}

	async testHandleTweetResponse(runtime: IAgentRuntime) {
		try {
			const testTweet = {
				id: "12345",
				text: "@testUser What do you think about AI?",
				username: "randomUser",
				entityId: "randomUserId",
				timestamp: Date.now() / 1000,
				conversationId: "67890",
				permanentUrl: "https://twitter.com/randomUser/status/12345",
				photos: [TEST_IMAGE],
				hashtags: [],
				mentions: [],
				thread: [],
				urls: [],
				videos: [],
			};

			await this.twitterClient.interaction.handleTweet({
				tweet: testTweet,
				message: {
					content: { text: testTweet.text, source: "twitter" },
					agentId: runtime.agentId,
					entityId: createUniqueUuid(runtime, testTweet.entityId),
					roomId: createUniqueUuid(runtime, testTweet.conversationId),
				},
				thread: [],
			});

			logger.success("Correct response decision.");
		} catch (error) {
			throw new Error(`Error handling tweet response: ${error}`);
		}
	}

	private async generateRandomTweetContent(
		runtime: IAgentRuntime,
		context?: string,
	) {
		let prompt: string;

		if (context === "image_post") {
			prompt = `Generate a short, engaging tweet to accompany an image. 
      It should feel natural and fit the tone of social media.
      Keep it brief (under 150 characters).
      It can be witty, descriptive, or thought-provoking.
      Avoid generic captions like "Look at this" or "Nice picture."`;
		} else {
			prompt = `Generate a natural and engaging tweet. 
      It should feel human, casual, and slightly thought-provoking. 
      Keep it under 280 characters. 
      Avoid generic bot-like statements. 
      Make it sound like something a real person would tweet. 
      Here’s an example format:
      - A random thought about life, technology, or human nature.
      - A short, witty observation about the current moment.
      - A lighthearted take on everyday situations.
      Do not include hashtags or emojis.`;
		}

		return await runtime.useModel(ModelTypes.TEXT_SMALL, {
			prompt,
		});
	}
}
