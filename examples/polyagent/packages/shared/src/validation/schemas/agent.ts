/**
 * Agent-related validation schemas
 */

import { z } from "zod";
import {
  createTrimmedStringSchema,
  SnowflakeIdSchema,
  URLSchema,
} from "./common";

/**
 * Agent authentication schema
 */
export const AgentAuthSchema = z
  .object({
    agentId: SnowflakeIdSchema.describe("Agent identifier (required)"),
    agentSecret: z
      .string()
      .min(32, { message: "Agent secret must be at least 32 characters" })
      .describe("Agent secret key (required)"),
  })
  .describe("Agent authentication credentials");

/**
 * Agent discovery query parameters schema
 */
export const AgentDiscoveryQuerySchema = z.object({
  strategies: z.string().optional(), // Comma-separated list of strategies
  markets: z.string().optional(), // Comma-separated list of markets
  minReputation: z.coerce.number().nonnegative().optional(),
  external: z.enum(["true", "false"]).optional(),
});

/**
 * Agent onboarding schema
 */
export const AgentOnboardSchema = z.object({
  agentName: createTrimmedStringSchema(1, 100),
  endpoint: URLSchema.optional(),
});

/**
 * Agent metadata schema (for responses)
 */
export const AgentMetadataSchema = z.object({
  id: SnowflakeIdSchema,
  name: z.string(),
  endpoint: URLSchema.nullable(),
  onChainRegistered: z.boolean(),
  nftTokenId: z.number().nullable(),
  agent0TrustScore: z.number(),
  reputationPoints: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Agent feedback submission schema
 */
export const AgentFeedbackCreateSchema = z.object({
  targetAgentId: z.union([
    z.number().int().positive(),
    z
      .string()
      .regex(/^\d+$/)
      .transform((val) => Number.parseInt(val, 10)),
  ]),
  rating: z
    .number()
    .int()
    .min(-5)
    .max(5, { message: "Rating must be between -5 and 5" }),
  comment: createTrimmedStringSchema(1, 1000),
});

/**
 * Agent feedback query parameters
 */
export const AgentFeedbackQuerySchema = z.object({
  agentId: z.union([z.number().int().positive(), z.string().min(1)]),
});

/**
 * Agent metadata ID parameter
 */
export const AgentIdParamSchema = z.object({
  agentId: z.string().min(1),
});

/**
 * Agent monitoring query parameters
 */
export const AgentMonitoringQuerySchema = z.object({
  agentId: z.string().optional(),
  limit: z.coerce.number().int().positive().optional().default(50),
});
