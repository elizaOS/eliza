import {
	asUUID,
	ChannelType,
	createUniqueUuid,
	logger,
	type Memory,
	type MessageReceivedHandlerParams,
	ModelType,
	parseKeyValueXml,
	parseJSONObjectFromText,
} from "@elizaos/core";
import { v4 as uuidv4 } from "uuid";
import { TRUST_LEADERBOARD_WORLD_SEED } from "./config";
import type { CommunityInvestorService } from "./service";
import {
	type Conviction,
	type Recommendation,
	ServiceType,
	SupportedChain,
	TRUST_MARKETPLACE_COMPONENT_TYPE,
	type UserTrustProfile,
} from "./types";

const RELEVANCE_CHECK_TEMPLATE = `
# Task: Relevance Check
Given the current message and recent conversation context, determine if the message is relevant to cryptocurrency discussions.
This includes topics like token mentions, trading, market sentiment, buy/sell signals, DeFi, NFTs, or financial advice related to crypto.

# Conversation Context
Current Message Sender: {{senderName}}
Current Message: "{{currentMessageText}}"

Recent Messages (if any):
{{recentMessagesContext}}

# Instructions
Respond with TOON only.
Fields:
isRelevant: true/false
reason: brief explanation
Focus SOLELY on relevance to crypto. Do not analyze for recommendations yet.

Example Output for relevant message:
isRelevant: true
reason: The message discusses price predictions for $ETH.

Example Output for irrelevant message:
isRelevant: false
reason: The message is about weekend plans.

# Your Analysis:
`;

const RECOMMENDATION_EXTRACTION_TEMPLATE = `
# Task: Extract Cryptocurrency Recommendations
Analyze the user's message to identify any explicit or strongly implied recommendations to buy or sell a cryptocurrency token, or strong criticisms.

# User Message
Sender: {{senderName}}
Message: "{{messageText}}"

# Instructions
If the message contains a recommendation or strong criticism:
1. Identify the token mentioned (ticker like $SOL or contract address). If a contract address, make sure it looks like one (e.g. long alphanumeric string).
2. Determine if the mention is a ticker (true/false).
3. Determine the sentiment: 'positive' (buy, pump, moon, good investment), 'negative' (sell, dump, scam, bad investment), or 'neutral' (general discussion without clear buy/sell intent).
4. Estimate the sender's conviction: 'NONE', 'LOW', 'MEDIUM', 'HIGH'.
5. Extract the direct quote from the message that forms the basis of the recommendation/criticism.

Respond with TOON only.
Use this shape:
recommendations[0]{tokenMentioned,isTicker,sentiment,conviction,quote}: SOL,true,positive,HIGH,$SOL is going to moon

If no new, clear recommendation or strong criticism is found:
recommendations:
Focus only on actionable recommendations or strong criticisms, not general token mentions without sentiment or conviction.

# Your Analysis:
`;

const MAX_RECENT_MESSAGES_FOR_CONTEXT = 5;
const MAX_RECOMMENDATIONS_IN_PROFILE = 50;
const DEFAULT_CHAIN = SupportedChain.SOLANA;
const RECENT_REC_DUPLICATION_TIMEFRAME_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Handles incoming messages and generates responses based on the provided runtime and message information.
 *
 * @param {MessageReceivedHandlerParams} params - The parameters needed for message handling, including runtime, message, and callback.
 * @returns {Promise<void>} - A promise that resolves once the message handling and response generation is complete.
 */
const messageReceivedHandler = async ({
	runtime,
	message,
	callback,
	onComplete,
}: MessageReceivedHandlerParams): Promise<void> => {
	const {
		entityId: currentMessageSenderId,
		roomId,
		id: messageId,
		content,
		createdAt,
		worldId: msgWorldId,
	} = message;
	const agentId = runtime.agentId;
	// Use the consistent, seeded ID for storing community investor plugin-specific components.
	const componentWorldId = createUniqueUuid(
		runtime,
		TRUST_LEADERBOARD_WORLD_SEED,
	);
	const _componentRoomId = componentWorldId; // Components will have their room set to this ID too.

	// Determine the worldId for the connection context (message's origin)
	const _connectionWorldId =
		msgWorldId || createUniqueUuid(runtime, currentMessageSenderId);

	// Critical: Log the content object and its type to diagnose the missing 'type' issue.
	logger.debug(
		`[CommunityInvestor] ensureConnection PRE-CHECK: Message ID: ${messageId}, Room ID: ${roomId}, Message Content: ${JSON.stringify(content)}`,
	);

	if (!roomId) {
		logger.error(
			`[CommunityInvestor] CRITICAL: roomId is missing for message ${messageId}. Aborting handler.`,
		);
		return;
	}

	if (!content || typeof content !== "object") {
		logger.error(
			`[CommunityInvestor] CRITICAL: message.content is null, undefined, or not an object for message ${messageId}. Aborting handler.`,
		);
		return;
	}

	// Default content.type if it's missing, as per user instruction.
	let connectionChannelType = content.type as ChannelType;
	if (!connectionChannelType) {
		logger.warn(
			`[CommunityInvestor] message.content.type is missing for message ${messageId} from source ${content.source} in room ${roomId}. ` +
				`Defaulting to ChannelType.GROUP.`,
		);
		connectionChannelType = ChannelType.GROUP; // Defaulting to GROUP
	}

	// Also check channelId as it's used in ensureConnection too
	let connectionChannelId = content.channelId as string;
	if (!connectionChannelId) {
		logger.warn(
			`[CommunityInvestor] WARNING: message.content.channelId is missing for message ${messageId} from source ${content.source} in room ${roomId}. ` +
				`Using roomId as fallback for channelId. Message content: ${JSON.stringify(content)}`,
		);
		connectionChannelId = roomId; // Fallback for channelId, might not always be correct but better than undefined for some runtimes
	}

	try {
		// Create a simple roomId for this message context if none provided
		const messageRoomId =
			roomId || createUniqueUuid(runtime.agentId, currentMessageSenderId);

		logger.debug(
			`[CommunityInvestor] Processing message from user ${currentMessageSenderId} in room ${messageRoomId}`,
		);

		// Ensure the agent's world exists before creating components within it
		try {
			await runtime.ensureWorldExists({
				id: componentWorldId, // This is now runtime.agentId
				name: `Social Alpha World for Agent ${componentWorldId}`,
				agentId: runtime.agentId, // The agent responsible for this world
				serverId: "community-investor-plugin", // A unique identifier for this plugin's worlds
				metadata: {},
			});
		} catch (error) {
			logger.debug(
				`[CommunityInvestor] World ${componentWorldId} already exists or error ensuring world: ${error}`,
			);
		}

		try {
			logger.debug(
				`[CommunityInvestor] Message from ${currentMessageSenderId} in room ${roomId}. Text: "${content.text?.substring(0, 50)}..."`,
			);

			if (currentMessageSenderId === agentId) {
				logger.debug("[CommunityInvestor] Skipping self-message.");
				onComplete?.();
				return;
			}

			const agentUserState = await runtime.getParticipantUserState(
				messageRoomId,
				agentId,
			);
			if (
				agentUserState === "MUTED" &&
				!content.text
					?.toLowerCase()
					.includes(runtime.character.name.toLowerCase())
			) {
				logger.debug(
					"[CommunityInvestor] Agent muted and not mentioned. Ignoring.",
				);
				onComplete?.();
				return;
			}

			const recentMessagesForContext = await runtime.getMemories({
				tableName: "messages",
				roomId: messageRoomId,
				count: MAX_RECENT_MESSAGES_FOR_CONTEXT,
				unique: false,
			});
			const history = recentMessagesForContext
				.slice(0, 10)
				.map((msg: Memory) => {
					const name =
						(msg.content as Record<string, string>)?.name ??
						msg.entityId.toString();
					const text = msg.content?.text ?? "";
					return `${name}: ${text}`;
				})
				.join("\n");

			const relevancePrompt = RELEVANCE_CHECK_TEMPLATE.replace(
				"{{senderName}}",
				String(content.name || currentMessageSenderId.toString()),
			)
				.replace("{{currentMessageText}}", String(content.text || ""))
				.replace("{{recentMessagesContext}}", history);

			// logger.debug(`[CommunityInvestor Handler] Relevance prompt being sent to useModel:\n${relevancePrompt}`);

			const relevanceResponseRaw = await runtime.useModel(
				ModelType.TEXT_LARGE,
				{
					prompt: relevancePrompt,
				},
			);
			logger.debug(
				`[HANDLER DEBUG] relevanceResponseRaw: '${relevanceResponseRaw}' (type: ${typeof relevanceResponseRaw})`,
			); // Changed to error for visibility

			const relevanceResult =
				parseKeyValueXml<Record<string, unknown>>(relevanceResponseRaw) ??
				parseJSONObjectFromText(relevanceResponseRaw);

			logger.debug(
				`[HANDLER DEBUG] Parsed relevanceResult: ${JSON.stringify(relevanceResult)} (type: ${typeof relevanceResult})`,
			); // Changed to error

			let isActuallyRelevant = false; // Default to false
			if (relevanceResult?.hasOwnProperty("isRelevant")) {
				if (typeof relevanceResult.isRelevant === "boolean") {
					isActuallyRelevant = relevanceResult.isRelevant;
				} else if (typeof relevanceResult.isRelevant === "string") {
					isActuallyRelevant =
						relevanceResult.isRelevant.toLowerCase() === "true";
				}
			}
			logger.debug(
				`[HANDLER DEBUG] isActuallyRelevant determined as: ${isActuallyRelevant}`,
			); // Changed to error

			if (!isActuallyRelevant) {
				logger.info(
					`[CommunityInvestor] Message determined NOT relevant. Reason: ${relevanceResult?.reason || "N/A"}. Returning.`,
				); // Changed from error to info
				onComplete?.();
				return;
			}

			logger.debug(
				`[CommunityInvestor] Message IS RELEVANT. Proceeding to extraction.`,
			); // Changed to error

			const extractionPrompt = RECOMMENDATION_EXTRACTION_TEMPLATE.replace(
				"{{senderName}}",
				String(content.name || currentMessageSenderId.toString()),
			).replace("{{messageText}}", String(content.text || ""));

			const extractionResponseRaw = await runtime.useModel(
				ModelType.TEXT_LARGE,
				{
					prompt: extractionPrompt,
				},
			);
			type ExtractedRec = {
				tokenMentioned: string;
				isTicker: boolean;
				sentiment: "positive" | "negative" | "neutral";
				conviction: "NONE" | "LOW" | "MEDIUM" | "HIGH";
				quote: string;
			};
			const extractionResult = (parseKeyValueXml<{
				recommendations?: ExtractedRec[];
			}>(extractionResponseRaw) ??
				parseJSONObjectFromText(extractionResponseRaw)) as {
				recommendations: ExtractedRec[];
			} | null;

			if (
				!extractionResult?.recommendations ||
				extractionResult.recommendations.length === 0
			) {
				logger.debug("[CommunityInvestor] No recommendations extracted.");
				onComplete?.();
				return;
			}

			logger.info(
				`[CommunityInvestor] Found ${extractionResult.recommendations.length} recommendations to process`,
			);

			const communityInvestorService = runtime.getService(
				ServiceType.COMMUNITY_INVESTOR,
			) as CommunityInvestorService;
			if (!communityInvestorService) {
				logger.error("[CommunityInvestor] Service not found!");
				onComplete?.();
				return;
			}

			const userProfileComponent = await runtime.getComponent(
				currentMessageSenderId,
				TRUST_MARKETPLACE_COMPONENT_TYPE,
				componentWorldId,
				agentId,
			);
			let userProfile: UserTrustProfile;

			if (!userProfileComponent?.data) {
				userProfile = {
					version: "1.0.0",
					userId: currentMessageSenderId,
					trustScore: 0,
					lastTrustScoreCalculationTimestamp: Date.now(),
					recommendations: [],
				};
				logger.debug(
					`[CommunityInvestor] Initializing new profile for ${currentMessageSenderId}`,
				);
			} else {
				userProfile = userProfileComponent.data as UserTrustProfile;
				if (!Array.isArray(userProfile.recommendations))
					userProfile.recommendations = [];
			}

			let profileUpdated = false;

			for (const extractedRec of extractionResult.recommendations) {
				if (
					extractedRec.sentiment === "neutral" ||
					!extractedRec.tokenMentioned?.trim()
				) {
					logger.debug(
						`[CommunityInvestor] Skipping neutral or empty token mention: "${extractedRec.quote}"`,
					);
					continue;
				}

				logger.debug(
					`[E2E TRACE] Extracted rec: ${JSON.stringify(extractedRec)}`,
				);

				let resolvedToken: {
					address: string;
					chain: SupportedChain;
					ticker?: string;
				} | null = null;
				const isTicker =
					extractedRec.isTicker === true ||
					String(extractedRec.isTicker).toLowerCase() === "true";
				if (isTicker) {
					resolvedToken = await communityInvestorService.resolveTicker(
						extractedRec.tokenMentioned,
						DEFAULT_CHAIN,
						recentMessagesForContext,
					);
				} else if (
					extractedRec.tokenMentioned.length > 20 &&
					extractedRec.tokenMentioned.match(/^[a-zA-Z0-9]+$/)
				) {
					resolvedToken = {
						address: extractedRec.tokenMentioned,
						chain: DEFAULT_CHAIN,
						ticker: undefined,
					}; // Assume address-like strings are on default chain for now
				} else {
					logger.debug(
						`[CommunityInvestor] Invalid address-like token: ${extractedRec.tokenMentioned}`,
					);
					logger.debug(
						`[E2E TRACE] Token mention ${extractedRec.tokenMentioned} not considered a valid address format.`,
					);
				}
				logger.debug(
					`[E2E TRACE] resolvedToken for "${extractedRec.quote}": ${JSON.stringify(resolvedToken)}`,
				);

				if (!resolvedToken) {
					logger.warn(
						`[CommunityInvestor] Could not resolve token for: "${extractedRec.quote}".`,
					);
					logger.debug(
						`[E2E TRACE] Skipping rec due to unresolved token: "${extractedRec.quote}"`,
					);
					continue;
				}

				logger.debug(
					`[E2E TRACE] Attempting to get token API data for ${resolvedToken.address}`,
				);
				const tokenAPIData = await communityInvestorService.getTokenAPIData(
					resolvedToken.address,
					resolvedToken.chain,
				);
				logger.debug(
					`[E2E TRACE] tokenAPIData for ${resolvedToken.address}: ${JSON.stringify(tokenAPIData)}`,
				);
				const priceAtRecommendation = tokenAPIData?.currentPrice; // Use current price as of message time

				const recTimestamp = createdAt || Date.now();
				const existingRecent = userProfile.recommendations.find(
					(r) =>
						r.tokenAddress === resolvedToken?.address &&
						r.recommendationType ===
							(extractedRec.sentiment === "positive" ? "BUY" : "SELL") &&
						recTimestamp - r.timestamp < RECENT_REC_DUPLICATION_TIMEFRAME_MS,
				);
				logger.debug(
					`[E2E TRACE] Existing recent duplicate check. Target: ${resolvedToken.address}, Type: ${extractedRec.sentiment === "positive" ? "BUY" : "SELL"}`,
				);
				if (existingRecent) {
					logger.debug(
						`[CommunityInvestor] Skipping duplicate rec for ${resolvedToken.address}`,
					);
					logger.debug(
						`[E2E TRACE] Found existing recent duplicate for ${resolvedToken.address}. Skipping.`,
					);
					continue;
				}

				const newRecommendation: Recommendation = {
					id: asUUID(uuidv4()),
					userId: currentMessageSenderId,
					messageId:
						messageId ||
						asUUID(
							createUniqueUuid(
								runtime,
								`${currentMessageSenderId}-${recTimestamp}`,
							),
						),
					timestamp: recTimestamp,
					tokenTicker: resolvedToken.ticker?.toUpperCase(),
					tokenAddress: resolvedToken.address,
					chain: resolvedToken.chain,
					recommendationType:
						extractedRec.sentiment === "positive" ? "BUY" : "SELL",
					conviction: extractedRec.conviction as Conviction,
					rawMessageQuote: extractedRec.quote,
					priceAtRecommendation: priceAtRecommendation, // Store price at time of recommendation
					processedForTradeDecision: false,
				};

				logger.debug(
					`[E2E TRACE] newRecommendation created: ${JSON.stringify(newRecommendation)}`,
				);

				userProfile.recommendations.unshift(newRecommendation);
				if (userProfile.recommendations.length > MAX_RECOMMENDATIONS_IN_PROFILE)
					userProfile.recommendations.pop();
				profileUpdated = true;
				logger.debug(
					`[E2E TRACE] profileUpdated is now true. Profile recommendation count: ${userProfile.recommendations.length}`,
				);
				logger.info(
					`[CommunityInvestor] Added ${newRecommendation.recommendationType} rec for user ${currentMessageSenderId}, token ${newRecommendation.tokenAddress}`,
				);

				await runtime.createTask({
					name: "PROCESS_TRADE_DECISION",
					description: `Process trade decision for rec ${newRecommendation.id}`,
					metadata: {
						recommendationId: newRecommendation.id,
						userId: currentMessageSenderId,
					},
					tags: ["socialAlpha", "tradeDecision"],
					roomId: messageRoomId,
					worldId: componentWorldId,
					entityId: currentMessageSenderId,
				});
				logger.debug(
					`[CommunityInvestor] Created PROCESS_TRADE_DECISION task for rec ID ${newRecommendation.id} in room/world ${componentWorldId}`,
				);
			}
			logger.debug(`[E2E TRACE] After loop, profileUpdated: ${profileUpdated}`);
			if (profileUpdated) {
				logger.debug(
					`[E2E TRACE] profileUpdated is true. Checking if userProfileComponent exists.`,
				);
				if (userProfileComponent) {
					logger.debug(
						`[E2E TRACE] Attempting to update component ${userProfileComponent.id}`,
					);
					await runtime.updateComponent({
						...userProfileComponent,
						data: userProfile,
					});
					logger.debug(
						`[CommunityInvestor] Updated component ${userProfileComponent.id} for ${currentMessageSenderId}`,
					);
				} else {
					const newComponentId = asUUID(uuidv4());
					logger.debug(
						`[E2E TRACE] Attempting to create new component with id ${newComponentId} for user ${currentMessageSenderId} in world ${componentWorldId} and room (set to world) ${componentWorldId}`,
					);
					await runtime.createComponent({
						id: newComponentId,
						entityId: currentMessageSenderId,
						agentId: agentId,
						worldId: componentWorldId,
						roomId: messageRoomId,
						sourceEntityId: agentId,
						type: TRUST_MARKETPLACE_COMPONENT_TYPE,
						createdAt: Date.now(),
						data: userProfile,
					});
					logger.info(
						`[CommunityInvestor] Created new component ${newComponentId} for ${currentMessageSenderId} with roomId ${componentWorldId}`,
					);
				}

				// Trigger trust score calculation which will also register the user
				logger.info(
					`[CommunityInvestor] Triggering trust score calculation for user ${currentMessageSenderId}`,
				);
				await communityInvestorService.calculateUserTrustScore(
					currentMessageSenderId,
					runtime,
				);
				logger.info(
					`[CommunityInvestor] Trust score calculation completed for user ${currentMessageSenderId}`,
				);
			} else {
				logger.info(
					`[CommunityInvestor] Profile NOT updated for message ${messageId}, user ${currentMessageSenderId}. No new valid recommendations extracted or token resolution failed.`,
				);
			}
		} catch (error) {
			logger.error(
				"[CommunityInvestor] Error in messageReceivedHandler:",
				error,
			);
		}
	} catch (error) {
		logger.error("[CommunityInvestor] Error in messageReceivedHandler:", error);
	} finally {
		onComplete?.();
	}
};

export const events = {
	MESSAGE_RECEIVED: [messageReceivedHandler],
};
