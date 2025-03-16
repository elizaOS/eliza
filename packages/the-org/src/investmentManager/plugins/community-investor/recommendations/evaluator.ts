import {
  type Evaluator,
  type IAgentRuntime,
  type Memory,
  ModelType,
  type State,
  type UUID,
  composePrompt,
} from '@elizaos/core';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import type { CommunityInvestorService } from '../tradingService.js';
import { type RecommendationMemory, ServiceType } from '../types.js';
import {
  extractXMLFromResponse,
  getZodJsonSchema,
  parseConfirmationResponse,
  parseRecommendationsResponse,
  parseSignalResponse,
} from '../utils.js';
import { examples } from './examples.js';
import { recommendationSchema } from './schema.js';

/**
 * Template for generating recommendation messages between agents.
 *
 * Include engaging tagline, recommendation report, and question asking the recipient agent if they like the recommendation.
 * Use emojis to make the message more engaging.
 * Precede the message with a tag containing the recipient agent's name.
 * Message should not contain more than 5 emojis and should not be too long.
 *
 * @param {string} recipientAgentName - The name of the recipient agent
 * @param {string} recommendation - The recommendation to be included in the message
 * @returns {string} - The formatted template for recommendation messages
 */
const recommendationFormatTemplate = `You are a crypto expert.

You will be given a recommendation.

Your goal is to write a message to the {{recipientAgentName}} asking if they like the recommendation.

The message will then be sent to the {{recipientAgentName}} for an illicited response.

Each Message should include the following information:

- Should enclude engaging tagline at the beginning.
- Should include a report of the recommendation.
- Should Always end in a question asking the {{recipientAgentName}} if they like the recommendation, can get creative with the this.
- Should use a few emojis to make the message more engaging.
- Should always precide the message with a tag containing the @{{recipientAgentName}}

The message should **NOT**:

- Contain more than 5 emojis.
- Be too long.

<recommendation>
{{recommendation}}
</recommendation>

# Response Instructions

When writing your response, follow these strict guidelines:

## Response Information

Respond with the following structure:

-MESSAGE: This is the message you will need to send to the {{recipientAgentName}}.

## Response Format

Respond with the following format:
<message>
**MESSAGE_TEXT_HERE**
</message>

## Response Example

<message>
@{{recipientAgentName}} Hey there! 🔍 I've got a fresh recommendation to run by you.

Based on my analysis, I'm seeing a HIGH conviction BUY signal for $PEPE. The signals are looking particularly strong right now.

What do you think about this play? Would love to get your take on it! 🚀
</message>

Now based on the recommendation, write your message.`;

/**
 * Analyzes a message to determine if it contains a signal related to cryptocurrency tokens.
 *
 * @param {string} message - The message to be analyzed.
 * @returns {string} - The signal of the message (0, 1, 2, or 3).
 */
const sentimentTemplate = `You are an expert crypto analyst and trader. You mainly specialize in analyzing cryptocurrency conversations and extracting signals from those conversations and messages.

You will be given a message.

Your goal is to identify whether or not the message purports to a signal. A signal is a message that contains a positive or negative sentiment towards a token. A token can only be a token address.

## RULES

Strictly follow the below rules:

- If the message suggests a positive sentiment or negative sentiment towards a token address, then the signal is 1.
- If the message suggests a neutral sentiment towards a token address i.e (GnQUsLcyZ3NXUAPXymWoefMYfCwmJazBVkko4vb7pump), then the signal is 0.
- If the message only contains a token address, then the signal is 0. example: GnQUsLcyZ3NXUAPXymWoefMYfCwmJazBVkko4vb7pump
- If message contains a token ticker ($PNUT), then the signal is 2.
- If the message does not contain a token address at all, then the signal is 3.

Here is the general format of a token address to base your analysis on:

<tokenAddress>gnvgqjgozwo2aqd9zlmymadozn83gryvdpunx53ufq2p</tokenAddress>
<tokenAddress>32vfamd12dthmwo9g5quce9sgvdv72yufk9pmp2dtbj7</tokenAddress>
<tokenAddress>GnQUsLcyZ3NXUAPXymWoefMYfCwmJazBVkko4vb7pump</tokenAddress>

The signal should include the following information:

- The signal of the message (0, 1, or 2, or 3)

The signal should **NOT**:

- Include words other than 0, 1, or 2, or 3

<message>
{{message}}
</message>

# Response Instructions

When writing your response, follow these strict instructions:

## Response Information

Respond with the following information:

- SIGNAL: The signal of the message (0, 1, or 2, or 3)

## Response Format

Respond in the following format:

<signal>**SIGNAL_HERE**</signal>

## Response Example

<signal>0</signal>

Now, based on the message provided, please respond with your signal.`;

/**
 * Template for creating a recommendation confirmation message for a crypto expert.
 *
 * @summary
 * This template provides guidelines for writing a message to the user for confirming a token recommendation.
 * The message should be engaging and include links to token addresses, accounts, and transactions.
 * It should end with a question asking the user if they want to proceed with the recommendation.
 * Response instructions and format are also provided for clarity.
 *
 * @param {string} user_message The user message provided.
 * @param {string} recommendation The recommendation for the token.
 * @param {string} token The overview of the token information.
 *
 * @return {string} The formatted recommendation confirmation message for user interaction.
 */
const recommendationConfirmTemplate = `You are {{agentName}}, a crypto expert.

You will be given a user message, recommendation, and token overview.

Your goal is to write a message to the user asking if they want to confirm the token recommendation.

The message will then be sent to the user for an illicited response.

Each Message should include the following information:

- Should include engaging tagline at the beginning.
- Should include a report of the token.
- Should always include links to the token addresses and accounts:
    - Token: https://solscan.io/token/[tokenAddress]
    - Account: https://solscan.io/account/[accountAddress]
    - Tx: https://solscan.io/tx/[txHash]
    - Pair: https://www.defined.fi/sol/[pairAddress]
- Should always use valid markdown links when possible.
- Should Always end in a question asking the user if they want to confirm the token recommendation, can get creative with the this.
- Should use a few emojis to make the message more engaging.

The message should **NOT**:

- Contain more than 5 emojis.
- Be too long.

<user_message>
{{msg}}
</user_message>

<recommendation>
{{recommendation}}
</recommendation>

<token_overview>
{{token}}
</token_overview>

# Response Instructions

When writing your response, follow these strict guidelines:

## Response Information

Respond with the following structure:

-MESSAGE: This is the message you will need to send to the user.

## Response Format

Respond with the following format:
<message>
**MESSAGE_TEXT_HERE**
</message>

## Response Example

<message>
Hello! Would you like to confirm the token recommendation for Kolwaii (KWAII)? Here are the details:

Token Overview:

- Name: Kolwaii
- Symbol: KWAII
- Chain: Solana
- Address: [6uVJY332tiYwo58g3B8p9FJRGmGZ2fUuXR8cpiaDpump](https://solscan.io/token/6uVJY332tiYwo58g3B8p9FJRGmGZ2fUuXR8cpiaDpump)
- Price: $0.01578
- Market Cap: $4,230,686
- 24h Trading Volume: $53,137,098.26
- Holders: 3,884
- Liquidity: $677,160.66
- 24h Price Change: +4.75%
- Total Supply: 999,998,189.02 KWAII

Top Trading Pairs:

1. KWAII/SOL - [View on Defined.fi](https://www.defined.fi/sol/ChiPAU1gj79o1tB4PXpB14v4DPuumtbzAkr3BnPbo1ru) - Price: $0.01578
2. KWAII/SOL - [View on Defined.fi](https://www.defined.fi/sol/HsnFjX8utMyLm7fVYphsr47nhhsqHsejP3JoUr3BUcYm) - Price: $0.01577
3. KWAII/SOL - [View on Defined.fi](https://www.defined.fi/sol/3czJZMWfobm5r3nUcxpZGE6hz5rKywegKCWKppaisM7n) - Price: $0.01523

Creator Information:

- Creator Address: [FTERkgMYziSVfcGEkZS55zYiLerZHWcMrjwt49aL9jBe](https://solscan.io/account/FTERkgMYziSVfcGEkZS55zYiLerZHWcMrjwt49aL9jBe)
- Creation Transaction: [View Transaction](https://solscan.io/tx/4PMbpyyQB9kPDKyeQaJGrMfmS2CnnHYp9nB5h4wiB2sDv7yHGoew4EgYgsaeGYTcuZPRpgKPKgrq4DLX4y8sX21y)

Would you like to proceed with the recommendation?
</message>

Now based on the user_message, recommendation, and token_overview, write your message.
`;

/**
 * Function that analyzes a conversation to identify new buy or sell recommendations for memecoins,
 * avoiding duplicates of existing recommendations.
 *
 * @param {string} token_metadata - The token metadata schema.
 * @param {Array} existing_recommendations - List of existing token recommendations to use as examples.
 * @param {string} conversation - The conversation to analyze for new recommendations.
 * @returns {string} - Returns the list of new recommendations in a specific format as described in the response format.
 */
const recommendationTemplate = `You are an expert crypto analyst and trader. You mainly specialize in analyzing cryptocurrency conversations and extracting trading recommendations from them.

You will be given a token_metadata schema, a list of existing token recommendations to use as examples, and a conversation.

Your goal is to identify new buy or sell recommendations for memecoins from a given conversation, avoiding duplicates of existing recommendations.

Each new recommendation should include the following information:

- A analysis of the recommendation
- A recommendation object that adheres to the recommendation schema

The new recommendations should **NOT**:

- Include any existing or duplicate recommendations
- Change the contract address, even if it contains words like "pump" or "meme"

Review the following recommendation schema:

<recommendation_schema>
{{schema}}
</recommendation_schema>

Next, analyze the conversation:

<conversation>
{{message}}
</conversation>

# Instructions and Guidelines:

1. Carefully read through the conversation, looking for messages from users that:

    - Mention specific token addresses
    - Contain words related to buying, selling, or trading tokens
    - Express opinions or convictions about tokens

2. Your analysis should consider:
    - Quote the relevant part of the conversation
    - Is this truly a new recommendation?
    - What is the recommender's username?
    - What is the conviction level (NONE, LOW, MEDIUM, HIGH)?
    - What type of recommendation is it (BUY, DONT_BUY, SELL, DONT_SELL, NONE), if neutral sentiment, then the type is BUY?
    - Is there a contract address mentioned?
    - How does this recommendation compare to the existing ones? List any similar existing recommendations.
    - Conclusion: Is this a new, valid recommendation?

# Response Instructions

When writing your response, follow these strict instructions:

Do not modify the contract address, even if it contains words like "pump" or "meme".

## Response Information

Respond with the following information:

- NEW_RECOMMENDATIONS: The list of new recommendations
    - RECOMMENDATION: A single recommendation. Contains a analysis and recommendation object
        - ANALYSIS: A detailed analysis of the recommendation
        - RECOMMENDATION_DATA: A recommendation that adheres to the recommendation schema
            - username: The username of the recommender
            - conviction: The conviction level (NONE, LOW, MEDIUM, HIGH)
            - type: The type of recommendation (BUY, DONT_BUY, SELL, DONT_SELL, NONE)
            - tokenAddress: The contract address of the token (null if not provided)

## Response Format

Respond in the following format:

<new_recommendations>
<recommendation>
<analysis>
**Analysis_of recommendation_here**
</analysis>
<recommendation_data>
<username>**username**</username>
<conviction>**conviction**</conviction>
<type>**type**</type>
<tokenAddress>**tokenAddress**</tokenAddress>
</recommendation_data>
</recommendation>
...remaining recommendations...
</new_recommendations>

## Response Example

<new_recommendations>
<recommendation>
<analysis>
Analyzing message from user CryptoFan123:
Quote: "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC is going to explode soon, buy now!" - Mentions token "HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC" - Suggests buying - Conviction seems HIGH - No existing recommendation for HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC in the list - No contract address provided - No similar existing recommendations found
Conclusion: This appears to be a new, valid recommendation.
</analysis>
<recommendation_data>
<username>CryptoFan123</username>
<conviction>HIGH</conviction>
<type>BUY</type>
<tokenAddress>HeLp6NuQkmYB4pYWo2zYs22mESHXPQYzXbB8n4V98jwC</tokenAddress>
</recommendation_data>
</recommendation>
...remaining recommendations...
</new_recommendations>

Now, based on the recommendation schema, the existing recommendations, and the conversation provided, please respond with your new token recommendations.`;

const TELEGRAM_CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID;

export const formatRecommendations = (recommendations: Memory[]) => {
  return recommendations
    .reverse()
    .map((rec: Memory) => `${JSON.stringify((rec.metadata as any).recommendation)}`)
    .join('\n');
};

/**
 * A recommendation evaluator that extracts recommendations to buy or sell memecoins/tokens from the conversation.
 *
 * @typedef {Object} recommendationEvaluator
 * @property {string} name - The name of the evaluator ("EXTRACT_RECOMMENDATIONS").
 * @property {Array} similes - An array of similes.
 * @property {boolean} alwaysRun - A boolean value indicating if the evaluator should always run.
 * @property {Function} validate - An asynchronous function that validates a message for recommendation.
 * @property {string} description - A description of the evaluator.
 * @property {Function} handler - An asynchronous function that handles the evaluation process.
 */
export const recommendationEvaluator: Evaluator = {
  name: 'EXTRACT_RECOMMENDATIONS',
  similes: [],
  alwaysRun: true,
  validate: async (_runtime: IAgentRuntime, message: Memory): Promise<boolean> => {
    console.log(
      'validating message for recommendation',
      message.content.text.length < 5 ? false : message.entityId !== message.agentId
    );

    if (message.content.text.length < 5) {
      return false;
    }

    return message.entityId !== message.agentId;
  },
  description:
    'Extract recommendations to buy or sell memecoins/tokens from the conversation, including details like ticker, contract address, conviction level, and recommender username.',
  async handler(runtime, message, state, options, callback) {
    try {
      await handler(runtime, message, state, options, callback);
    } catch (error) {
      console.error(error);
      throw error;
    }
  },
  examples,
};

/**
 * Asynchronous function that acts as a handler for some runtime with the given message and optional state and options.
 *
 * @param {IAgentRuntime} runtime - The runtime to handle.
 * @param {Memory} message - The message to handle.
 * @param {State} [state] - The optional state to use.
 * @param {Object} [_options] - Optional additional options.
 * @param {Function} [callback] - Optional callback function.
 */
async function handler(
  runtime: IAgentRuntime,
  message: Memory,
  state?: State,
  _options?: { [key: string]: unknown },
  callback?: any
) {
  console.log('Running the evaluator');
  if (!state) return;

  const { agentId, roomId } = message;

  if (!runtime.getService(ServiceType.COMMUNITY_INVESTOR)) {
    console.log('no trading service');
    return;
  }

  const tradingService = runtime.getService<CommunityInvestorService>(
    ServiceType.COMMUNITY_INVESTOR
  )!;

  if (!tradingService.hasWallet('solana')) {
    console.log('no registered solana wallet in trading service');
    return;
  }

  if (message.entityId === message.agentId) return;
  console.log('evaluating recommendations....');

  console.log('message', message.content.text);

  const sentimentPrompt = composePrompt({
    template: sentimentTemplate,
    state: {
      message: message.content.text,
    },
  });

  const sentimentText = await runtime.useModel(ModelType.TEXT_LARGE, {
    prompt: sentimentPrompt,
  });

  const signal = extractXMLFromResponse(sentimentText, 'signal');

  const signalInt = parseSignalResponse(signal);

  console.log('signalInt', signalInt);

  if (signalInt === 2 && callback) {
    const responseMemory: Memory = {
      content: {
        text: 'Please provide a token address!',
        inReplyTo: message.id ? message.id : undefined,
        buttons: [],
      },
      entityId: message.entityId,
      agentId: message.agentId,
      metadata: {
        ...message.metadata,
      },
      roomId: message.roomId,
      createdAt: Date.now() * 1000,
    };
    await callback(responseMemory);
    return;
  }

  if (signalInt === 3) {
    console.log('signal is 3, skipping not related to tokens at all');
    return;
  }
  // Get recommendations from trust db by user that sent the message
  const recentRecommendations = (await runtime.getMemories({
    tableName: 'recommendations',
    roomId,
    count: 10,
  })) as RecommendationMemory[];

  // Remove any recommendations older than 10 minutes
  Promise.all(
    await recentRecommendations
      .filter((r) => r.createdAt && Date.now() - r.createdAt > 10 * 60 * 1000)
      .map((r) => runtime.deleteMemory(r.id as UUID))
  );

  console.log('message', message);

  const messageData = {
    text: message.content.text,
    entityId: message.entityId,
    agentId: message.agentId,
    roomId: message.roomId,
    username: message.content.username ?? message.content.userName,
  };

  // nicely format message data

  const messageString = `username: ${messageData.username}: text: ${messageData.text}
	entityId: ${messageData.entityId} | agentId: ${messageData.agentId} | roomId: ${messageData.roomId}`;

  const prompt = composePrompt({
    state: {
      schema: JSON.stringify(getZodJsonSchema(recommendationSchema)),
      message: messageString,
    },
    template: recommendationTemplate,
  });

  // Only function slowing us down: generateText
  const [text, participants] = await Promise.all([
    runtime.useModel(ModelType.TEXT_LARGE, {
      prompt,
      stopSequences: [],
    }),
    runtime.getParticipantsForRoom(message.roomId),
  ]);

  console.log('Participants', participants);

  const newRecommendationsBlock = extractXMLFromResponse(text, 'new_recommendations');

  const parsedRecommendations = parseRecommendationsResponse(newRecommendationsBlock);

  if (parsedRecommendations.length === 0) {
    console.log('no recommendations found');
    return;
  }

  const recommendationDataMap = parsedRecommendations
    .map((r) => r.recommendation_data)
    .filter((c) => c.conviction !== 'null' && c.type !== 'null');

  const recommendations = z.array(recommendationSchema).parse(recommendationDataMap);

  const tokenRecommendationsSet = new Set(
    recentRecommendations
      .filter((r) => (r.metadata as any).recommendation.confirmed)
      .map((r) => (r.metadata as any).recommendation.tokenAddress)
  );

  const filteredRecommendations = recommendations
    // TODO: Replace username with entity ID
    .filter((rec) => rec.username !== runtime.character.name)
    .filter((rec) => !tokenRecommendationsSet.has(rec.tokenAddress));

  if (filteredRecommendations.length === 0) {
    console.log('no new recommendations found');
    return;
  }

  // TODO: getAccounts in database
  const users = await Promise.all(participants.map((id) => runtime.getEntityById(id))).then(
    (users) => users.filter((user) => !!user)
  );

  // Only Reply to first recommendation
  let hasAgentRepliedTo = false;

  for (const recommendation of filteredRecommendations) {
    if (
      recommendation.tokenAddress !== 'null' &&
      recommendation.ticker !== 'null' &&
      recommendation.ticker
    ) {
      const tokenAddress = await tradingService.resolveTicker(
        'solana', // todo: extract from recommendation?
        recommendation.ticker
      );

      recommendation.tokenAddress = tokenAddress ?? undefined;
    }

    if (!recommendation.tokenAddress) continue;

    const token = await tradingService.getTokenOverview('solana', recommendation.tokenAddress!);

    recommendation.ticker = token.symbol;

    console.log('users', users);

    // find the first user Id from a user with the username that we extracted
    const user = users.find((user) => {
      return (
        user.names
          .map((name) => name.toLowerCase().trim())
          .includes(recommendation.username.toLowerCase().trim()) || user.id === message.entityId
      );
    });

    if (!user) {
      console.warn('Could not find name: ', recommendation.username);
      continue;
    }

    const recommendationString = `username: ${recommendation.username} | ticker: ${recommendation.ticker} | tokenAddress: ${recommendation.tokenAddress} | conviction: ${recommendation.conviction} | type: ${recommendation.type}`;

    if (TELEGRAM_CHANNEL_ID) {
      (async () => {
        const prompt = composePrompt({
          state: {
            recommendation: recommendationString,
            recipientAgentName: runtime.character.name,
          },
          template: recommendationFormatTemplate,
        });

        const text = await runtime.useModel(ModelType.TEXT_SMALL, {
          prompt,
        });

        const extractedXML = extractXMLFromResponse(text, 'message');

        const formattedResponse = parseConfirmationResponse(extractedXML);

        console.log(formattedResponse);

        if (callback) {
          const responseMemory: Memory = {
            content: {
              text: formattedResponse,
              buttons: [],
              channelId: TELEGRAM_CHANNEL_ID,
              source: 'telegram',
              actions: ['CONFIRM_RECOMMENDATION'],
            },
            entityId: message.entityId,
            agentId: message.agentId,
            roomId: message.roomId,
            metadata: message.metadata,
            createdAt: Date.now() * 1000,
          };
          callback(responseMemory);
        }
      })();
    }

    const recMemory: Memory = {
      id: uuid() as UUID,
      entityId: message.entityId,
      agentId,
      content: { text: '', recommendation },
      roomId,
      createdAt: Date.now(),
    };

    // Store Recommendation
    await Promise.all([runtime.createMemory(recMemory, 'recommendations', true)]);

    const tokenString = JSON.stringify(token, (_, v) => {
      if (typeof v === 'bigint') return v.toString();
      return v;
    });

    console.log('forming memory from message', message);

    if (callback && !hasAgentRepliedTo) {
      console.log('generating text');
      if (signalInt === 0) {
        const responseMemory: Memory = {
          content: {
            text: 'Are you just looking for details, or are you recommending this token?',
            inReplyTo: message.id ? message.id : undefined,
            buttons: [],
            actions: ['CONFIRM_RECOMMENDATION'],
            source: 'telegram',
          },
          entityId: message.entityId,
          agentId: message.agentId,
          metadata: message.metadata,
          roomId: message.roomId,
          createdAt: Date.now() * 1000,
        };
        await callback(responseMemory);
        return;
      }
      if (recommendation.conviction === 'MEDIUM' || recommendation.conviction === 'HIGH') {
        // temp message/memory
        console.log('message', message.metadata);
        const actionMemory = {
          id: message.id,
          entityId: message.entityId,
          agentId,
          content: {
            text: message.content.text,
            actions: ['CONFIRM_RECOMMENDATION'],
          },
          roomId,
          createdAt: Date.now(),
        };
        await runtime.processActions(
          {
            ...message,
            ...actionMemory,
            actions: [''],
          } as Memory,
          [actionMemory as Memory],
          state,
          callback
        );
        return;
      }
      const prompt = composePrompt({
        state: {
          agentName: runtime.character.name,
          msg: message.content.text,
          recommendation: recommendationString,
          token: tokenString,
        },
        template: recommendationConfirmTemplate,
      });

      console.log('prompt', prompt);

      const res = await runtime.useModel(ModelType.TEXT_LARGE, {
        prompt,
      });

      const agentResponseMsg = extractXMLFromResponse(res, 'message');
      const question = parseConfirmationResponse(agentResponseMsg);

      console.log('question', question);

      console.log('forming response memory');
      const responseMemory: Memory = {
        content: {
          text: question,
          inReplyTo: message.id ? message.id : undefined,
          buttons: [],
          actions: ['CONFIRM_RECOMMENDATION'],
          source: 'telegram',
        },
        entityId: message.entityId,
        agentId: message.agentId,
        roomId: message.roomId,
        metadata: message.metadata,
        createdAt: Date.now() * 1000,
      };
      console.log('response memory', responseMemory);
      await callback(responseMemory);
      hasAgentRepliedTo = true;
    }
  }
  hasAgentRepliedTo = false;

  return recommendations;
}
