import { z } from 'zod';

/**
 * Type definition for MessageRecommendation based on the schema recommendationSchema
 */
export type MessageRecommendation = z.infer<typeof recommendationSchema>;

/**
 * Schema for extracting trading recommendations from conversational text, capturing the key components of who made the recommendation, what asset was discussed, what action was recommended, and how strongly it was recommended
 */
export const recommendationSchema = z
  .object({
    username: z
      .string()
      .describe('The username of the person making the recommendation in the conversation'),

    ticker: z
      .string()
      .optional()
      .nullable()
      .describe(
        "The ticker symbol of the recommended asset (e.g., 'BTC', 'AAPL'). Optional as recommendations may discuss assets without explicit tickers"
      ),

    tokenAddress: z
      .string()
      .optional()
      .nullable()
      .describe(
        'The blockchain contract address of the token if mentioned. This helps disambiguate tokens that might share similar names or symbols'
      ),

    type: z
      .enum(['BUY', 'SELL', 'DONT_BUY', 'DONT_SELL', 'NONE'])
      .describe(
        'The type of trading recommendation being made. This captures both positive recommendations (buy/sell) and explicit warnings against actions'
      ),

    conviction: z
      .enum(['NONE', 'LOW', 'MEDIUM', 'HIGH'])
      .describe(
        'The level of confidence or urgency expressed in the recommendation, helping prioritize stronger signals'
      ),
  })
  .describe(
    'Schema for extracting trading recommendations from conversational text, capturing the key components of who made the recommendation, what asset was discussed, what action was recommended, and how strongly it was recommended'
  );
