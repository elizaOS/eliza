/**
 * Market and trading validation schemas
 */
import { z } from "zod";

import {
  NumericStringSchema,
  PaginationSchema,
  SnowflakeIdSchema,
  UserIdSchema,
} from "./common";

/**
 * Open perp position schema
 */
export const OpenPerpPositionSchema = z.object({
  ticker: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9-]+$/, "Ticker must be uppercase alphanumeric"),
  side: z.enum(["LONG", "SHORT"]),
  size: NumericStringSchema, // Position size as string for precision
  leverage: z
    .number()
    .int()
    .min(1)
    .max(100, "Leverage must be between 1x and 100x"),
  slippage: z.number().min(0).max(0.1).default(0.01), // 1% default max slippage
});

/**
 * Close perp position schema
 *
 * NOTE: percentage and slippage fields are defined for future support but
 * are not currently implemented in PerpMarketService. Positions are closed
 * entirely at market price.
 */
export const ClosePerpPositionSchema = z.object({
  /** Close partial position (0-1, e.g., 0.5 = close 50%). Defaults to 1 (full close). */
  percentage: z.number().min(0).max(1).optional(),
  /** Max slippage tolerance (0-1, e.g., 0.01 = 1%). Rejects if price moved beyond this. */
  slippage: z.number().min(0).max(0.1).default(0.01),
});

/**
 * Buy prediction market shares schema
 */
export const BuyPredictionSharesSchema = z.object({
  amount: NumericStringSchema, // Purchase amount as string for precision
  maxPrice: z.number().min(0).max(1).optional(), // Max price willing to pay (0-1)
  slippage: z.number().min(0).max(0.1).default(0.05), // 5% default
});

/**
 * Sell prediction market shares schema
 */
export const SellPredictionSharesSchema = z
  .object({
    shares: NumericStringSchema.optional(), // Sell specific number of shares (string for precision)
    percentage: z.number().min(0).max(1).optional(), // Or sell percentage of holdings
    minPrice: z.number().min(0).max(1).optional(), // Minimum price willing to accept
    slippage: z.number().min(0).max(0.1).default(0.05),
  })
  .refine(
    (data) => {
      // Must specify either shares or percentage, but not both
      return (data.shares !== undefined) !== (data.percentage !== undefined);
    },
    {
      message: "Specify either shares or percentage, but not both",
    },
  );

/**
 * Market query schema
 */
export const MarketQuerySchema = PaginationSchema.extend({
  status: z.enum(["ACTIVE", "RESOLVED", "CANCELLED"]).optional(),
  category: z.string().optional(),
  minLiquidity: z.coerce.number().nonnegative().optional(),
  maxLiquidity: z.coerce.number().nonnegative().optional(),
  search: z.string().optional(),
});

/**
 * User positions query schema
 */
export const UserPositionsQuerySchema = z.object({
  userId: UserIdSchema,
  type: z.enum(["perp", "prediction", "all"]).default("all"),
  status: z.enum(["open", "closed", "all"]).default("open"),
  page: z.coerce.number().positive().default(1),
  limit: z.coerce.number().positive().max(100).default(20),
});

/**
 * Position ID param schema
 */
export const PositionIdParamSchema = z.object({
  positionId: SnowflakeIdSchema,
});

/**
 * Market ID param schema
 */
export const MarketIdParamSchema = z.object({
  marketId: SnowflakeIdSchema,
});

/**
 * Ticker param schema
 */
export const TickerParamSchema = z.object({
  ticker: z
    .string()
    .min(1)
    .max(20)
    .regex(/^[A-Z0-9-]+$/),
});
