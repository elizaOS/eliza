/**
 * Agent Monetization API
 *
 * Manages monetization settings for public agents.
 * Agents can set markup percentage on base inference costs.
 *
 * GET /api/v1/agents/[agentId]/monetization - Get monetization settings
 * PUT /api/v1/agents/[agentId]/monetization - Update monetization settings
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { agentMonetizationService } from "@/lib/services/agent-monetization";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";

const UpdateMonetizationSchema = z.object({
  monetizationEnabled: z.boolean().optional(),
  markupPercentage: z.number().min(0).max(1000).optional(),
  payoutWalletAddress: z.string().optional(),
});

/**
 * GET /api/v1/agents/[agentId]/monetization
 * Gets monetization settings for a specific agent.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { agentId } = await params;

  const agent = await charactersService.getById(agentId);
  if (!agent) {
    return NextResponse.json(
      { success: false, error: "Agent not found" },
      { status: 404 },
    );
  }

  // Check ownership
  if (
    agent.user_id !== user.id &&
    agent.organization_id !== user.organization_id
  ) {
    return NextResponse.json(
      { success: false, error: "Not authorized to view this agent" },
      { status: 403 },
    );
  }

  const info = await agentMonetizationService.getAgentMonetization(agentId);

  return NextResponse.json({
    success: true,
    monetization: {
      enabled: agent.monetization_enabled,
      markupPercentage: Number(agent.inference_markup_percentage || 0),
      payoutWalletAddress: agent.payout_wallet_address,
      isPublic: agent.is_public,
      totalEarnings: info?.totalEarnings || 0,
      totalRequests: info?.totalRequests || 0,
      a2aEnabled: agent.a2a_enabled,
      mcpEnabled: agent.mcp_enabled,
    },
  });
}

/**
 * PUT /api/v1/agents/[agentId]/monetization
 * Updates monetization settings for a specific agent.
 *
 * Note: Agent must be public to enable monetization.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { agentId } = await params;

  const body = await request.json();
  const validation = UpdateMonetizationSchema.safeParse(body);

  if (!validation.success) {
    return NextResponse.json(
      {
        success: false,
        error: "Invalid request",
        details: validation.error.format(),
      },
      { status: 400 },
    );
  }

  const result = await agentMonetizationService.updateSettings(
    agentId,
    user.id,
    validation.data,
  );

  if (!result.success) {
    return NextResponse.json(
      { success: false, error: result.error },
      { status: 400 },
    );
  }

  logger.info("[Agent Monetization API] Settings updated", {
    agentId,
    userId: user.id,
    settings: validation.data,
  });

  // Return updated settings
  const agent = await charactersService.getById(agentId);

  return NextResponse.json({
    success: true,
    monetization: {
      enabled: agent?.monetization_enabled || false,
      markupPercentage: Number(agent?.inference_markup_percentage || 0),
      payoutWalletAddress: agent?.payout_wallet_address,
      isPublic: agent?.is_public || false,
    },
  });
}
