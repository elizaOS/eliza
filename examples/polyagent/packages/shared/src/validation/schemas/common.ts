/**
 * Common reusable Zod schemas for validation across the application
 */

import { z } from "zod";
import { JsonValueSchema } from "../../types/common";
import { isValidSnowflakeId } from "../../utils/snowflake";

/**
 * Snowflake ID validation schema
 * Used for all entity IDs in the system (users, markets, positions, etc.)
 */
export const SnowflakeIdSchema = z
  .string()
  .refine((val) => isValidSnowflakeId(val), {
    message: "Invalid Snowflake ID format",
  });

/**
 * User ID schema - accepts UUID, Privy DID, or username formats
 * Examples:
 * - UUID: "550e8400-e29b-41d4-a716-446655440000"
 * - Privy DID: "did:privy:cm6sqq4og01qw9l70rbmyjn20"
 * - Username: "eddy-snowjob" or "john_doe"
 */
export const UserIdSchema = z.string().refine(
  (val) => {
    // Check if it's a valid UUID
    const uuidRegex =
      /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;
    // Check if it's a valid Privy DID
    const privyDidRegex = /^did:privy:[a-z0-9]+$/;
    // Check if it's a valid username (3-30 chars, letters, numbers, underscores, hyphens)
    const usernameRegex = /^[a-zA-Z0-9_-]{3,30}$/;

    return (
      uuidRegex.test(val) || privyDidRegex.test(val) || usernameRegex.test(val)
    );
  },
  {
    message:
      "Invalid user identifier. Must be a UUID, Privy DID (did:privy:...), or username",
  },
);

/**
 * Email validation schema
 */
export const EmailSchema = z.string().email({
  message: "Invalid email address",
});

/**
 * DateTime validation schema (ISO 8601)
 */
export const DateTimeSchema = z.string().datetime({
  message: "Invalid datetime format. Use ISO 8601",
});

/**
 * Ethereum wallet address validation
 */
export const WalletAddressSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum wallet address");

/**
 * Transaction hash validation
 */
export const TransactionHashSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]{64}$/, "Invalid transaction hash");

/**
 * Pagination schema for list endpoints
 */
export const PaginationSchema = z.object({
  page: z.coerce.number().positive().default(1),
  limit: z.coerce.number().positive().max(100).default(20),
  sortBy: z.string().optional(),
  sortOrder: z.enum(["asc", "desc"]).default("desc"),
});

/**
 * Date range schema for filtering
 */
export const DateRangeSchema = z
  .object({
    startDate: DateTimeSchema.optional(),
    endDate: DateTimeSchema.optional(),
  })
  .refine(
    (data) => {
      if (data.startDate && data.endDate) {
        return new Date(data.startDate) <= new Date(data.endDate);
      }
      return true;
    },
    {
      message: "Start date must be before or equal to end date",
    },
  );

/**
 * Money/Amount schema with currency
 */
export const MoneySchema = z.object({
  amount: z.number().positive({
    message: "Amount must be positive",
  }),
  currency: z
    .string()
    .length(3, "Currency code must be 3 characters")
    .default("USD"),
});

/**
 * Percentage schema (0-100)
 */
export const PercentageSchema = z.number().min(0).max(100, {
  message: "Percentage must be between 0 and 100",
});

/**
 * Decimal percentage schema (0-1)
 */
export const DecimalPercentageSchema = z.number().min(0).max(1, {
  message: "Percentage must be between 0 and 1",
});

/**
 * URL validation schema
 */
export const URLSchema = z.string().url({
  message: "Invalid URL format",
});

/**
 * Phone number validation (basic international format)
 */
export const PhoneNumberSchema = z
  .string()
  .regex(/^\+?[1-9]\d{1,14}$/, "Invalid phone number format");

/**
 * Username validation
 */
export const UsernameSchema = z
  .string()
  .min(3, "Username must be at least 3 characters")
  .max(30, "Username must be at most 30 characters")
  .regex(
    /^[a-zA-Z0-9_-]+$/,
    "Username can only contain letters, numbers, underscores, and hyphens",
  );

/**
 * Password validation with strength requirements
 */
export const PasswordSchema = z
  .string()
  .min(8, "Password must be at least 8 characters")
  .regex(/[A-Z]/, "Password must contain at least one uppercase letter")
  .regex(/[a-z]/, "Password must contain at least one lowercase letter")
  .regex(/[0-9]/, "Password must contain at least one number")
  .regex(
    /[^A-Za-z0-9]/,
    "Password must contain at least one special character",
  );

/**
 * API key validation
 */
export const APIKeySchema = z
  .string()
  .regex(/^[a-zA-Z0-9]{32,64}$/, "Invalid API key format");

/**
 * Market ID schema (e.g., BTC-USD, ETH-USDT)
 */
export const MarketIdSchema = z
  .string()
  .regex(
    /^[A-Z]+-[A-Z]+$/,
    "Market ID must be in format BASE-QUOTE (e.g., BTC-USD)",
  );

/**
 * Strategy type enum
 */
export const StrategyTypeSchema = z.enum([
  "TREND_FOLLOWING",
  "MEAN_REVERSION",
  "ARBITRAGE",
  "MARKET_MAKING",
  "MOMENTUM",
  "PAIRS_TRADING",
  "STATISTICAL_ARBITRAGE",
]);

/**
 * Order side enum
 */
export const OrderSideSchema = z.enum(["BUY", "SELL"]);

/**
 * Order type enum
 */
export const OrderTypeSchema = z.enum([
  "MARKET",
  "LIMIT",
  "STOP",
  "STOP_LIMIT",
]);

/**
 * Position status enum
 */
export const PositionStatusSchema = z.enum(["OPEN", "CLOSED", "LIQUIDATED"]);

/**
 * Pool status enum
 */
export const PoolStatusSchema = z.enum([
  "ACTIVE",
  "INACTIVE",
  "LOCKED",
  "DEPRECATED",
]);

/**
 * Agent tier enum
 */
export const AgentTierSchema = z.enum([
  "BRONZE",
  "SILVER",
  "GOLD",
  "PLATINUM",
  "DIAMOND",
]);

/**
 * Risk tolerance enum
 */
export const RiskToleranceSchema = z.enum([
  "LOW",
  "MEDIUM",
  "HIGH",
  "VERY_HIGH",
]);

/**
 * Time frame enum for trading
 */
export const TimeFrameSchema = z.enum([
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "1w",
  "1M",
]);

/**
 * Numeric string schema (for blockchain amounts)
 */
export const NumericStringSchema = z
  .string()
  .regex(/^\d+(\.\d+)?$/, "Must be a valid numeric string");

/**
 * Big number schema (for large blockchain values)
 */
export const BigNumberSchema = z
  .string()
  .regex(/^\d+$/, "Must be a valid big number string");

/**
 * Hex string schema
 */
export const HexStringSchema = z
  .string()
  .regex(/^0x[a-fA-F0-9]+$/, "Must be a valid hex string");

/**
 * Optional string that transforms empty strings to undefined
 */
export const OptionalStringSchema = z
  .string()
  .transform((val) => (val === "" ? undefined : val))
  .optional();

/**
 * Trimmed string schema (removes leading/trailing whitespace)
 */
export const TrimmedStringSchema = z.string().transform((val) => val.trim());

/**
 * Helper to create a trimmed string with min/max validation
 */
export function createTrimmedStringSchema(min?: number, max?: number) {
  let schema = z.string();
  if (min !== undefined) {
    schema = schema.min(min);
  }
  if (max !== undefined) {
    schema = schema.max(max);
  }
  return schema.transform((val) => val.trim());
}

/**
 * Search query schema with sanitization
 */
export const SearchQuerySchema = z
  .string()
  .min(1, "Search query cannot be empty")
  .max(100, "Search query too long")
  .transform((val) => val.trim().toLowerCase());

/**
 * File upload schema
 */
export const FileUploadSchema = z.object({
  filename: z.string(),
  mimetype: z.string(),
  size: z
    .number()
    .positive()
    .max(10 * 1024 * 1024, "File size must be less than 10MB"),
  data: z.string(), // Base64 encoded
});

/**
 * Generic ID parameter schema - uses Snowflake IDs
 */
export const IdParamSchema = z.object({
  id: SnowflakeIdSchema,
});

/**
 * Prediction markets accept both snowflake IDs and UUIDs.
 * Note: Consider migrating prediction markets to snowflake IDs for consistency in the future.
 */
export const PredictionMarketIdSchema = z.object({
  id: z.string().min(1),
});

/**
 * Generic success response schema
 * Uses JsonValueSchema for data to allow any JSON-serializable value while maintaining type safety
 */
export const SuccessResponseSchema = z.object({
  success: z.literal(true),
  message: z.string().optional(),
  data: JsonValueSchema.optional(),
});

/**
 * Generic error response schema
 */
export const ErrorResponseSchema = z.object({
  error: z.object({
    message: z.string(),
    code: z.string(),
    violations: z
      .array(
        z.object({
          field: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
    context: z.record(z.string(), JsonValueSchema).optional(),
  }),
});

/**
 * Batch operation schema
 */
export function createBatchSchema<T extends z.ZodType>(
  itemSchema: T,
  maxItems = 100,
) {
  return z
    .array(itemSchema)
    .min(1, "At least one item is required")
    .max(maxItems, `Maximum ${maxItems} items allowed`);
}

/**
 * Leaderboard query parameters schema
 */
export const LeaderboardQuerySchema = z.object({
  page: z.coerce
    .number()
    .int()
    .min(0)
    .default(1)
    .transform((val) => Math.max(1, val)), // Clamp to min 1, default 1
  pageSize: z.coerce
    .number()
    .int()
    .nonnegative()
    .default(100)
    .transform((val) => Math.max(1, Math.min(val, 100))), // Clamp to min 1, max 100
  minPoints: z.coerce.number().nonnegative().default(500), // Show all with >500 reputation
  pointsType: z
    .string()
    .optional()
    .transform((val) => {
      // Default to 'all' if invalid, undefined, or empty
      if (!val || !["all", "earned", "referral"].includes(val)) {
        return undefined; // Will be handled as 'all' in route handler (pointsType ?? 'all')
      }
      return val as "all" | "earned" | "referral";
    }),
});
