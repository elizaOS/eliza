import {
	type Action,
	type IAgentRuntime,
	type Memory,
	type MemoryMetadata,
	type UUID,
	logger,
} from "@elizaos/core";
import { v4 as uuid } from "uuid";
import type { CommunityInvestorService } from "../tradingService";
import { Conviction, RecommendationType, ServiceType } from "../types";
import type { MessageRecommendation } from "./schema";

// Use type intersection for extended metadata
/**
 * Represents extended metadata for a memory, including client-related information.
 * @typedef {Object} ExtendedMetadata
 * @property {string} [clientUsername] - The username of the client associated with the memory
 * @property {string} [clientUserId] - The user ID of the client associated with the memory
 * @property {string} [clientChatId] - The chat ID of the client associated with the memory
 */
type ExtendedMetadata = MemoryMetadata & {
	clientUsername?: string;
	clientUserId?: string;
	clientChatId?: string;
};

/**
 * Action to confirm a recommendation to buy or sell memecoins/tokens in a user recommendations provider from the trust plugin.
 * @typedef {Object} Action
 * @property {string} name - The name of the action
 * @property {string} description - Description of the action
 * @property {Array<Array<{name: string, content: Object}>>} examples - Examples of how to use the action
 * @property {Array<string>} similes - Array of similes related to the action
 * @property {Function} handler - Asynchronous function to handle confirming a recommendation
 * @property {Function} validate - Asynchronous function to validate the message
 */
export const confirmRecommendation: Action = {
	name: "CONFIRM_RECOMMENDATION",
	description:
		"Confirms <draft_recommendations> to buy or sell memecoins/tokens in <user_recommendations_provider> from the <trust_plugin>",
	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "do you wish to confirm this recommendation?\n {...recomendation}",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "yes, I would",
				},
			},
			{
				name: "{{name1}}",
				content: {
					text: "<NONE>",
					actions: ["CONFIRM_RECOMMENDATION"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "Are you just looking for details, or are you recommending this token?",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "I am recommending this token",
				},
			},
			{
				name: "{{name1}}",
				content: {
					text: "<NONE>",
					actions: ["CONFIRM_RECOMMENDATION"],
				},
			},
		],
	],
	similes: ["CONFIRM_RECOMMENDATION"],

	async handler(
		runtime: IAgentRuntime,
		message,
		_state,
		_options,
		callback: any,
	) {
		console.log("confirmRecommendation is running");
		if (!runtime.getService(ServiceType.COMMUNITY_INVESTOR)) {
			console.log("no trading service");
			await runtime.createMemory({
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: {
					thought: "No trading service found",
					actions: ["CONFIRM_RECOMMENDATION_FAILED"],
				},
			}, "messages");
			return;
		}

		// Emote to signal that the recommendation is being confirmed
		if (callback) {
			console.log(
				"emoting to signal that the recommendation is being confirmed",
			);
			const responseMemory: Memory = {
				content: {
					text: "Placing recommendation...",
					inReplyTo: message.id ? message.id : undefined,
					actions: ["CONFIRM_RECOMMENDATION"],
				},
				entityId: message.entityId,
				agentId: message.agentId,
				roomId: message.roomId,
				metadata: {
					type: "reaction",
					reaction: {
						type: [{ type: "emoji", emoji: "👍" }],
						onlyReaction: true,
					},
				},
				createdAt: Date.now() * 1000,
			};
			await callback(responseMemory);
		}

		const tradingService = runtime.getService<CommunityInvestorService>(
			ServiceType.COMMUNITY_INVESTOR,
		)!;

		if (!tradingService.hasWallet("solana")) {
			console.log("no registered solana wallet in trading service");
			await runtime.createMemory({
				entityId: runtime.agentId,
				agentId: runtime.agentId,
				roomId: message.roomId,
				content: {
					thought: "No registered solana wallet in trading service",
					actions: ["CONFIRM_RECOMMENDATION_FAILED"],
				},
			}, "messages");
			return;
		}

		const recentRecommendations = await runtime.getMemories({
			tableName: "recommendations",
			roomId: message.roomId,
			count: 20,
		});

		const newUserRecommendations = recentRecommendations
			.filter((m) => m.entityId === message.entityId)
			.sort((a, b) => (b?.createdAt ?? 0) - (a?.createdAt ?? 0));

		if (newUserRecommendations.length === 0) return;

		//     const prompt = composePromptFromState({
		//         state: {
		//             ...state,
		//             recommendations: formatRecommendations(newUserRecommendations),
		//             message: message.content.text,
		//         },
		//         template: extractConfirmationsTemplate,
		//     });

		//     const text = await generateText({
		//         runtime,
		//         prompt,
		//         modelType: ModelType.TEXT_SMALL,
		//         stop: [],
		//     });
		//     const xmlResponse = extractXMLFromResponse(text, "tokens");
		//const tokens = parseTokensResponse(xmlResponse);

		const tokens = [
			(newUserRecommendations[0]?.metadata as any).recommendation?.tokenAddress ?? "",
		];

		if (!Array.isArray(tokens) || tokens[0] === "") return;
		logger.info(tokens);

		try {
			const participants = await runtime
				
				.getParticipantsForRoom(message.roomId);

			const entities = await Promise.all(
				participants.map((id) =>
					runtime.getEntityById(id),
				),
			).then((entities) => entities.filter((participant) => !!participant));

			for (const tokenAddress of [tokens[tokens.length - 1]]) {
				const memory = newUserRecommendations.find(
					(r) =>
						(r.metadata as any).recommendation.tokenAddress === tokenAddress,
				);

				if (!memory) continue;

				const recommendation = (memory.metadata as any).recommendation as MessageRecommendation;

				const participant = entities.find((participant) => {
					return (
						participant.names
							.map((name) => name.toLowerCase().trim())
							.includes(recommendation.username.toLowerCase().trim()) ||
						participant.id === message.entityId
					);
				});

				if (!participant) {
					console.warn("Could not find participant: ", recommendation.username);
					continue;
				}

				const entity = await runtime
					
					.getEntityById(participant.id);

				const result = await tradingService.handleRecommendation(entity, {
					chain: "solana", // TODO: handle multichain
					conviction:
						recommendation.conviction === "HIGH"
							? Conviction.HIGH
							: recommendation.conviction === "MEDIUM"
								? Conviction.MEDIUM
								: Conviction.LOW,
					tokenAddress: recommendation.tokenAddress!,
					type:
						recommendation.type === "BUY"
							? RecommendationType.BUY
							: RecommendationType.SELL,
					timestamp: message.createdAt
						? new Date(message.createdAt)
						: new Date(),
					metadata: {
						msg: message.content.text ?? "CONFIRMATION",
						msgId: message.id!,
						chatId: (message.metadata as ExtendedMetadata)?.clientChatId,
					},
				});

				const newUUID = uuid() as UUID;

				if (callback && result) {
					switch (recommendation.type) {
						case "BUY": {
							const responseMemory: Memory = {
								id: newUUID,
								content: {
									text: `Simulation buy started for token: ${recommendation.ticker} (${recommendation.tokenAddress})`,
									inReplyTo: message.id ? message.id : undefined,
									actions: ["CONFIRM_RECOMMENDATION_BUY_STARTED"],
								},
								entityId: participant.id,
								agentId: message.agentId,
								roomId: message.roomId,
								metadata: {
									type: "CONFIRM_RECOMMENDATION",
									recommendation,
									confirmed: true,
								},
								createdAt: Date.now() * 1000,
							};
							await callback(responseMemory);
							break;
						}
						case "DONT_BUY":
						case "SELL":
						case "DONT_SELL":
							break;
					}
				}
			}
		} catch (error) {
			console.error(error);
		}
	},

	async validate(_runtime, message) {
		if (message.agentId === message.entityId) return false;
		return true;
	},
};
