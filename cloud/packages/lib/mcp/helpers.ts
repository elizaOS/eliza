/**
 * MCP Tool Helper Utilities
 *
 * Provides common functionality for MCP tools including caching, credit management,
 * and error handling. Reduces code duplication across 20+ tool implementations.
 *
 * Usage Pattern:
 * ```typescript
 * server.tool("my_tool", schema, async (params) => {
 *   const context = await getMCPContext();
 *
 *   // Use cached org (50ms → 5ms)
 *   const org = context.org;
 *
 *   // Try cache first
 *   const cached = await context.getToolCache("my_tool", params);
 *   if (cached) return cached;
 *
 *   // Execute expensive operation
 *   const result = await expensiveOperation(params);
 *
 *   // Cache result
 *   await context.setToolCache("my_tool", params, result);
 *
 *   return result;
 * });
 * ```
 */

import type { Organization } from "@/db/repositories";
import {
  getCachedToolResult,
  invalidateToolCache as invalidateToolCacheInternal,
  setCachedToolResult,
} from "@/lib/cache/mcp-tool-cache";
import { getCachedOrganization } from "@/lib/cache/organizations-cache";
import { creditsService } from "@/lib/services/credits";
import type { UserWithOrganization } from "@/lib/types";
import { logger } from "@/lib/utils/logger";

/**
 * MCP Tool Execution Context
 * Provides access to common resources needed by tools
 */
export interface MCPToolContext {
  /** Authenticated user with org data */
  user: UserWithOrganization;

  /** Cached organization (faster than repeated DB queries) */
  org: Organization;

  /** Get cached tool result (if available) */
  getToolCache: (toolName: string, params: unknown) => Promise<unknown | null>;

  /** Set tool result in cache */
  setToolCache: (toolName: string, params: unknown, result: unknown) => Promise<void>;

  /** Invalidate tool cache */
  invalidateToolCache: (toolName: string, params?: unknown) => Promise<void>;

  /** Deduct credits with automatic refund on error */
  deductCredits: (
    amount: number,
    description: string,
    metadata?: Record<string, unknown>,
  ) => Promise<{
    success: boolean;
    newBalance: number;
    transactionId: string | null;
  }>;

  /** Refund credits (e.g., on error) */
  refundCredits: (
    amount: number,
    description: string,
    metadata?: Record<string, unknown>,
  ) => Promise<void>;
}

/**
 * Create MCP tool context from authenticated user
 * This is the main entry point for tool implementations
 *
 * @param user - Authenticated user from requireAuth/requireAuthOrApiKey
 * @returns Tool execution context with caching and utilities
 */
export async function createMCPContext(user: UserWithOrganization): Promise<MCPToolContext> {
  // Ensure user has an organization (MCP tools not available for anonymous users)
  if (!user.organization_id) {
    throw new Error("User must belong to an organization to use MCP tools");
  }

  // Get cached organization (90% faster than DB query)
  const org = await getCachedOrganization(user.organization_id);

  if (!org) {
    throw new Error("Organization not found");
  }

  return {
    user,
    org,

    async getToolCache(toolName: string, params: unknown) {
      return await getCachedToolResult(toolName, params, org.id);
    },

    async setToolCache(toolName: string, params: unknown, result: unknown) {
      await setCachedToolResult(toolName, params, org.id, result);
    },

    async invalidateToolCache(toolName: string, params?: unknown) {
      await invalidateToolCacheInternal(toolName, org.id, params);
    },

    async deductCredits(amount: number, description: string, metadata?: Record<string, unknown>) {
      const result = await creditsService.deductCredits({
        organizationId: org.id,
        amount,
        description,
        metadata,
      });

      return {
        success: result.success,
        newBalance: result.newBalance,
        transactionId: result.transaction?.id || null,
      };
    },

    async refundCredits(amount: number, description: string, metadata?: Record<string, unknown>) {
      await creditsService.refundCredits({
        organizationId: org.id,
        amount,
        description,
        metadata,
      });
    },
  };
}

/**
 * Wrap a paid tool with automatic credit management
 * Handles deduction, refund on error, and optional caching
 *
 * @param toolName - Name of the tool
 * @param cost - Credit cost (fixed amount or function)
 * @param options - Tool options (caching, etc.)
 * @param handler - Tool implementation
 * @returns Wrapped handler with credit management
 */
export function withCredits<TParams, TResult>(
  toolName: string,
  cost: number | ((params: TParams) => number),
  options: {
    /** Enable result caching (for idempotent tools) */
    cacheable?: boolean;
    /** Custom error message on insufficient credits */
    insufficientCreditsMessage?: string;
  } = {},
  handler: (params: TParams, context: MCPToolContext) => Promise<TResult>,
): (params: TParams, context: MCPToolContext) => Promise<TResult> {
  return async (params: TParams, context: MCPToolContext): Promise<TResult> => {
    const toolCost = typeof cost === "function" ? cost(params) : cost;

    // Check cache first (if enabled)
    if (options.cacheable) {
      const cached = await context.getToolCache(toolName, params);
      if (cached !== null) {
        logger.debug(`[MCP:${toolName}] Cache hit, returning cached result`);
        return cached as TResult;
      }
    }

    // Check balance before deducting
    if (Number(context.org.credit_balance) < toolCost) {
      throw new Error(
        options.insufficientCreditsMessage ||
          `Insufficient credits. Required: ${toolCost}, Available: ${context.org.credit_balance}`,
      );
    }

    // Deduct credits
    const deduction = await context.deductCredits(toolCost, `MCP Tool: ${toolName}`, {
      tool: toolName,
      params,
    });

    if (!deduction.success) {
      throw new Error(
        options.insufficientCreditsMessage ||
          `Insufficient credits. Required: ${toolCost}, Available: ${deduction.newBalance}`,
      );
    }

    logger.info(
      `[MCP:${toolName}] Deducted ${toolCost} credits (balance: ${deduction.newBalance})`,
    );

    try {
      // Execute tool
      const result = await handler(params, context);

      // Cache result if enabled
      if (options.cacheable) {
        await context.setToolCache(toolName, params, result);
      }

      return result;
    } catch (error) {
      // Refund credits on error
      logger.error(`[MCP:${toolName}] Tool failed, refunding ${toolCost} credits:`, error);

      await context.refundCredits(toolCost, `MCP Tool Refund: ${toolName} (error)`, {
        tool: toolName,
        error: error instanceof Error ? error.message : String(error),
      });

      throw error; // Re-throw to preserve error handling
    }
  };
}

/**
 * Wrap a free tool with optional caching
 * No credit management, but provides context and caching utilities
 *
 * @param toolName - Name of the tool
 * @param options - Tool options
 * @param handler - Tool implementation
 * @returns Wrapped handler
 */
export function withCache<TParams, TResult>(
  toolName: string,
  options: {
    /** Enable result caching */
    cacheable?: boolean;
  } = {},
  handler: (params: TParams, context: MCPToolContext) => Promise<TResult>,
): (params: TParams, context: MCPToolContext) => Promise<TResult> {
  return async (params: TParams, context: MCPToolContext): Promise<TResult> => {
    // Check cache first (if enabled)
    if (options.cacheable) {
      const cached = await context.getToolCache(toolName, params);
      if (cached !== null) {
        logger.debug(`[MCP:${toolName}] Cache hit, returning cached result`);
        return cached as TResult;
      }
    }

    // Execute tool
    const result = await handler(params, context);

    // Cache result if enabled
    if (options.cacheable) {
      await context.setToolCache(toolName, params, result);
    }

    return result;
  };
}

/**
 * Format MCP tool response
 * Standardizes response format across all tools
 */
export function formatMCPResponse(
  data: unknown,
  isError: boolean = false,
): {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
} {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2),
      },
    ],
    ...(isError && { isError: true }),
  };
}

/**
 * Format MCP error response
 */
export function formatMCPError(error: unknown): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  const errorMessage = error instanceof Error ? error.message : String(error);
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify({ error: errorMessage }, null, 2),
      },
    ],
    isError: true,
  };
}
