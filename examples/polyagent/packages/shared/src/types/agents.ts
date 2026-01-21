/**
 * Agent Type Definitions
 *
 * Shared types for agent capabilities and profiles
 */

import { z } from "zod";

export const GameNetworkInfoSchema = z.object({
  chainId: z.number(),
  registryAddress: z.string(),
  reputationAddress: z.string().optional(),
  marketAddress: z.string().optional(),
});
export type GameNetworkInfo = z.infer<typeof GameNetworkInfoSchema>;

export const AgentCapabilitiesSchema = z.object({
  strategies: z.array(z.string()).optional().default([]),
  markets: z.array(z.string()).optional().default([]),
  actions: z.array(z.string()).optional().default([]),
  version: z.string().optional().default("1.0.0"),
  x402Support: z.boolean().optional(),
  platform: z.string().optional(),
  userType: z.string().optional(),
  gameNetwork: GameNetworkInfoSchema.optional(),

  // OASF Taxonomy Support
  skills: z.array(z.string()).optional().default([]),
  domains: z.array(z.string()).optional().default([]),

  // A2A Communication Endpoints
  a2aEndpoint: z.string().optional(),
  mcpEndpoint: z.string().optional(),
});
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
