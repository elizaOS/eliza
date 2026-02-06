/**
 * Credit-related MCP tools
 * Tools for checking balance, usage, transactions, and billing
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod3";
import { creditsService } from "@/lib/services/credits";
import { usageService } from "@/lib/services/usage";
import { redeemableEarningsService } from "@/lib/services/redeemable-earnings";
import { agentBudgetService } from "@/lib/services/agent-budgets";
import { getAuthContext } from "../lib/context";
import { jsonResponse, errorResponse } from "../lib/responses";

export function registerCreditTools(server: McpServer): void {
  // Check Credits - View balance and recent transactions
  server.registerTool(
    "check_credits",
    {
      description:
        "Check balance and recent transactions for your organization",
      inputSchema: {
        includeTransactions: z
          .boolean()
          .optional()
          .describe("Include recent transactions in the response"),
        limit: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe("Number of recent transactions to include"),
      },
    },
    async ({ includeTransactions = false, limit = 5 }) => {
      try {
        const { user } = getAuthContext();
        const org = user.organization;

        const response: {
          balance: number;
          organizationId: string;
          organizationName: string;
          transactions?: Array<{
            id: string;
            amount: number;
            type: string;
            description: string;
            createdAt: string;
          }>;
        } = {
          balance: Number(org.credit_balance),
          organizationId: org.id,
          organizationName: org.name,
        };

        if (includeTransactions) {
          const transactions =
            await creditsService.listTransactionsByOrganization(
              user.organization_id,
              limit,
            );
          response.transactions = transactions.map((t) => ({
            id: t.id,
            amount: Number(t.amount),
            type: t.type,
            description: t.description || "No description",
            createdAt: t.created_at.toISOString(),
          }));
        }

        return jsonResponse(response);
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to check credits",
        );
      }
    },
  );

  // Get Recent Usage - View API usage statistics
  server.registerTool(
    "get_recent_usage",
    {
      description:
        "Get recent API usage statistics including models used, costs, and tokens",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .default(10)
          .describe("Number of recent usage records to fetch"),
      },
    },
    async ({ limit = 10 }) => {
      try {
        const { user } = getAuthContext();

        const usageRecords = await usageService.listByOrganization(
          user.organization_id,
          limit,
        );

        const formattedUsage = usageRecords.map((record) => ({
          id: record.id,
          type: record.type,
          model: record.model,
          provider: record.provider,
          inputTokens: record.input_tokens,
          outputTokens: record.output_tokens,
          inputCost: record.input_cost || 0,
          outputCost: record.output_cost || 0,
          totalCost:
            Number(record.input_cost || 0) + Number(record.output_cost || 0),
          isSuccessful: record.is_successful,
          errorMessage: record.error_message,
          createdAt: record.created_at.toISOString(),
        }));

        const totalCost = formattedUsage.reduce(
          (sum, record) => sum + record.totalCost,
          0,
        );

        return jsonResponse({
          usage: formattedUsage,
          summary: {
            totalRecords: formattedUsage.length,
            totalCost,
          },
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error ? error.message : "Failed to fetch usage",
        );
      }
    },
  );

  // Get Credit Summary - Complete credit overview
  server.registerTool(
    "get_credit_summary",
    {
      description: "Get complete credit summary. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const { user } = getAuthContext();
        const org = user.organization;

        const redeemable = await redeemableEarningsService.getBalance(user.id);
        const agentBudgets = await agentBudgetService.getOrgBudgets(
          user.organization_id,
        );
        const totalAgentBudgets = agentBudgets.reduce((sum, b) => {
          const allocated = Number(b.allocated_budget);
          const spent = Number(b.spent_budget);
          return sum + Math.max(allocated - spent, 0);
        }, 0);

        return jsonResponse({
          success: true,
          summary: {
            organizationCredits: Number(org.credit_balance),
            redeemableEarnings: redeemable,
            totalAgentBudgets,
            agentCount: agentBudgets.length,
          },
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get credit summary",
        );
      }
    },
  );

  // List Credit Transactions
  server.registerTool(
    "list_credit_transactions",
    {
      description: "List credit transactions. FREE tool.",
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .default(50)
          .describe("Max results"),
        hours: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("Filter to last N hours"),
      },
    },
    async ({ limit, hours }) => {
      try {
        const { user } = getAuthContext();
        let transactions = await creditsService.listTransactionsByOrganization(
          user.organization_id,
          limit,
        );

        if (hours) {
          const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);
          transactions = transactions.filter(
            (t) => new Date(t.created_at) >= cutoffTime,
          );
        }

        return jsonResponse({
          success: true,
          transactions: transactions.map((t) => ({
            id: t.id,
            amount: Number(t.amount),
            type: t.type,
            description: t.description,
            createdAt: t.created_at,
          })),
          total: transactions.length,
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to list transactions",
        );
      }
    },
  );

  // List Credit Packs
  server.registerTool(
    "list_credit_packs",
    {
      description: "List available credit packs for purchase. FREE tool.",
      inputSchema: {},
    },
    async () => {
      try {
        const packs = await creditsService.listActiveCreditPacks();

        return jsonResponse({
          success: true,
          packs: packs.map((p) => {
            const metadata = p.metadata as {
              currency?: string;
              popular?: boolean;
            };
            const currency =
              typeof metadata.currency === "string" ? metadata.currency : "USD";
            const popular =
              typeof metadata.popular === "boolean" ? metadata.popular : false;

            return {
              id: p.id,
              name: p.name,
              credits: Number(p.credits),
              price: Number(p.price_cents) / 100,
              currency,
              popular,
            };
          }),
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to list credit packs",
        );
      }
    },
  );

  // Get Billing Usage
  server.registerTool(
    "get_billing_usage",
    {
      description: "Get billing usage statistics. FREE tool.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(90)
          .optional()
          .default(30)
          .describe("Days to include"),
      },
    },
    async ({ days }) => {
      try {
        const { user } = getAuthContext();
        const usage = await usageService.listByOrganization(
          user.organization_id,
          1000,
        );

        const cutoffTime = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
        const recentUsage = usage.filter(
          (u) => new Date(u.created_at) >= cutoffTime,
        );

        const totalCost = recentUsage.reduce(
          (sum, u) =>
            sum + Number(u.input_cost || 0) + Number(u.output_cost || 0),
          0,
        );
        const totalTokens = recentUsage.reduce(
          (sum, u) => sum + (u.input_tokens || 0) + (u.output_tokens || 0),
          0,
        );

        return jsonResponse({
          success: true,
          usage: {
            period: `${days} days`,
            totalRequests: recentUsage.length,
            totalTokens,
            totalCost,
            byType: {
              chat: recentUsage.filter((u) => u.type === "chat").length,
              image: recentUsage.filter((u) => u.type === "image").length,
              video: recentUsage.filter((u) => u.type === "video").length,
              embedding: recentUsage.filter((u) => u.type === "embedding")
                .length,
            },
          },
        });
      } catch (error) {
        return errorResponse(
          error instanceof Error
            ? error.message
            : "Failed to get billing usage",
        );
      }
    },
  );
}
