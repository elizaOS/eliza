/**
 * Trading-related validation schemas
 */

import { z } from "zod";
import { JsonValueSchema } from "../../types/common";
import {
  DateTimeSchema,
  DecimalPercentageSchema,
  OrderSideSchema,
  OrderTypeSchema,
  SnowflakeIdSchema,
  TimeFrameSchema,
  UserIdSchema,
} from "./common";

/**
 * Create trade order schema
 */
export const CreateTradeOrderSchema = z
  .object({
    poolId: SnowflakeIdSchema.optional(), // Optional if personal trade
    marketType: z.enum(["perp", "prediction", "spot"]),
    ticker: z.string().optional(), // For perps/spot
    marketId: z.string().optional(), // For prediction markets
    side: OrderSideSchema,
    orderType: OrderTypeSchema,
    size: z.number().positive(),
    price: z.number().positive().optional(), // Required for limit orders
    stopPrice: z.number().positive().optional(), // For stop orders
    leverage: z.number().min(1).max(100).default(1), // For perps
    timeInForce: z.enum(["GTC", "IOC", "FOK", "GTT"]).default("GTC"),
    expiresAt: DateTimeSchema.optional(), // For GTT orders
  })
  .refine(
    (data) => {
      // Validate price for limit orders
      if (data.orderType === "LIMIT" || data.orderType === "STOP_LIMIT") {
        if (!data.price) return false;
      }
      // Validate stop price for stop orders
      if (data.orderType === "STOP" || data.orderType === "STOP_LIMIT") {
        if (!data.stopPrice) return false;
      }
      return true;
    },
    {
      message:
        "Price required for limit orders, stop price required for stop orders",
    },
  )
  .refine(
    (data) => {
      // Validate market identifiers
      if (data.marketType === "prediction") {
        return !!data.marketId;
      }
      return !!data.ticker;
    },
    {
      message:
        "Ticker required for perp/spot, marketId required for predictions",
    },
  );

/**
 * Update trade order schema (for modifying open orders)
 */
export const UpdateTradeOrderSchema = z.object({
  orderId: SnowflakeIdSchema,
  price: z.number().positive().optional(),
  size: z.number().positive().optional(),
  stopPrice: z.number().positive().optional(),
});

/**
 * Cancel trade order schema
 */
export const CancelTradeOrderSchema = z.object({
  orderId: SnowflakeIdSchema,
});

/**
 * Close position schema
 */
export const ClosePositionSchema = z
  .object({
    positionId: SnowflakeIdSchema,
    percentage: DecimalPercentageSchema.optional(), // Close partial percentage
    size: z.number().positive().optional(), // Or close specific size
  })
  .refine((data) => !data.percentage || !data.size, {
    message: "Specify either percentage or size, not both",
  });

/**
 * Trade signal schema (for AI/algorithmic trading)
 */
export const TradeSignalSchema = z.object({
  marketType: z.enum(["perp", "prediction", "spot"]),
  ticker: z.string().optional(),
  marketId: z.string().optional(),
  signal: z.enum(["BUY", "SELL", "HOLD", "CLOSE"]),
  confidence: DecimalPercentageSchema,
  size: z.number().positive().optional(),
  price: z.number().positive().optional(),
  stopLoss: z.number().positive().optional(),
  takeProfit: z.number().positive().optional(),
  timeframe: TimeFrameSchema.optional(),
  reasoning: z.string().max(1000).optional(),
  metadata: z.record(z.string(), JsonValueSchema).optional(),
});

/**
 * Market data query schema
 */
export const MarketDataQuerySchema = z.object({
  marketType: z.enum(["perp", "prediction", "spot"]),
  ticker: z.string().optional(),
  marketId: z.string().optional(),
  timeframe: TimeFrameSchema,
  startTime: DateTimeSchema.optional(),
  endTime: DateTimeSchema.optional(),
  limit: z.number().positive().max(1000).default(100),
});

/**
 * Position query schema
 */
export const PositionQuerySchema = z.object({
  poolId: SnowflakeIdSchema.optional(),
  userId: UserIdSchema.optional(),
  marketType: z.enum(["perp", "prediction", "spot"]).optional(),
  ticker: z.string().optional(),
  marketId: z.string().optional(),
  status: z.enum(["OPEN", "CLOSED", "LIQUIDATED"]).optional(),
  includeHistory: z.boolean().default(false),
});

/**
 * Trade history query schema
 */
export const TradeHistoryQuerySchema = z.object({
  poolId: SnowflakeIdSchema.optional(),
  userId: UserIdSchema.optional(),
  marketType: z.enum(["perp", "prediction", "spot"]).optional(),
  ticker: z.string().optional(),
  startDate: DateTimeSchema.optional(),
  endDate: DateTimeSchema.optional(),
  side: OrderSideSchema.optional(),
  includeMetadata: z.boolean().default(false),
});

/**
 * Risk parameters schema
 */
export const RiskParametersSchema = z.object({
  maxPositionSize: z.number().positive(),
  maxLeverage: z.number().min(1).max(100),
  maxDrawdown: DecimalPercentageSchema,
  stopLossPercentage: DecimalPercentageSchema,
  takeProfitPercentage: DecimalPercentageSchema.optional(),
  maxOpenPositions: z.number().positive().max(100),
  dailyLossLimit: z.number().positive().optional(),
  marginCallLevel: DecimalPercentageSchema.default(0.5), // 50%
  liquidationLevel: DecimalPercentageSchema.default(0.25), // 25%
});

/**
 * Trade execution response schema
 */
export const TradeExecutionResponseSchema = z.object({
  orderId: SnowflakeIdSchema,
  status: z.enum([
    "PENDING",
    "FILLED",
    "PARTIALLY_FILLED",
    "CANCELLED",
    "REJECTED",
  ]),
  filledSize: z.number(),
  filledPrice: z.number().optional(),
  fees: z.number(),
  timestamp: DateTimeSchema,
  transactionHash: z.string().optional(),
  errorMessage: z.string().optional(),
});

/**
 * Position response schema
 */
export const PositionResponseSchema = z.object({
  id: SnowflakeIdSchema,
  poolId: SnowflakeIdSchema.nullable(),
  userId: SnowflakeIdSchema.nullable(),
  marketType: z.string(),
  ticker: z.string().nullable(),
  marketId: z.string().nullable(),
  side: z.string(),
  entryPrice: z.number(),
  currentPrice: z.number(),
  size: z.number(),
  leverage: z.number().nullable(),
  liquidationPrice: z.number().nullable(),
  unrealizedPnL: z.number(),
  realizedPnL: z.number().nullable(),
  margin: z.number().optional(),
  maintenanceMargin: z.number().optional(),
  openedAt: DateTimeSchema,
  closedAt: DateTimeSchema.nullable(),
  updatedAt: DateTimeSchema,
});

/**
 * Order book schema
 */
export const OrderBookSchema = z.object({
  marketType: z.string(),
  ticker: z.string().nullable(),
  marketId: z.string().nullable(),
  bids: z.array(
    z.object({
      price: z.number(),
      size: z.number(),
      orders: z.number().optional(),
    }),
  ),
  asks: z.array(
    z.object({
      price: z.number(),
      size: z.number(),
      orders: z.number().optional(),
    }),
  ),
  timestamp: DateTimeSchema,
});

/**
 * Market statistics schema
 */
export const MarketStatsSchema = z.object({
  marketType: z.string(),
  ticker: z.string().nullable(),
  marketId: z.string().nullable(),
  price: z.number(),
  change24h: z.number(),
  changePercent24h: z.number(),
  volume24h: z.number(),
  high24h: z.number(),
  low24h: z.number(),
  openInterest: z.number().optional(),
  fundingRate: z.number().optional(), // For perps
  nextFundingTime: DateTimeSchema.optional(),
  markPrice: z.number().optional(),
  indexPrice: z.number().optional(),
  timestamp: DateTimeSchema,
});

/**
 * Prediction market buy/sell schema
 */
export const PredictionMarketTradeSchema = z.object({
  side: z.enum(["yes", "no"], {
    message: 'Side must be either "yes" or "no"',
  }),
  amount: z
    .number()
    .positive({ message: "Amount must be positive" })
    .min(1, { message: "Minimum order size is ƀ1" }),
});

/**
 * Prediction market sell schema (shares-based)
 */
export const PredictionMarketSellSchema = z.object({
  shares: z
    .number()
    .positive({ message: "Shares must be positive" })
    .min(0.01, { message: "Minimum shares to sell is 0.01" }),
  positionId: SnowflakeIdSchema.optional(),
});

/**
 * Perpetual position open schema
 */
export const PerpOpenPositionSchema = z.object({
  ticker: z.string().min(1, { message: "Ticker is required" }),
  side: z.enum(["long", "short"], {
    message: 'Side must be either "long" or "short"',
  }),
  size: z.number().positive({ message: "Size must be positive" }),
  leverage: z
    .number()
    .int({ message: "Leverage must be an integer" })
    .min(1, { message: "Minimum leverage is 1x" })
    .max(100, { message: "Maximum leverage is 100x" }),
  /** Max slippage tolerance (0-1, e.g., 0.01 = 1%). Rejects if spot/mark deviation exceeds this. */
  maxSlippage: z.number().min(0).max(1).optional(),
});
