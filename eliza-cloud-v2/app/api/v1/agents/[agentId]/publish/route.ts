/**
 * Agent Publish API
 *
 * Publishes an agent (makes it public).
 *
 * POST /api/v1/agents/[agentId]/publish - Publish agent (make public)
 * DELETE /api/v1/agents/[agentId]/publish - Unpublish agent (make private)
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { dbWrite } from "@/db/client";
import { userCharacters } from "@/db/schemas/user-characters";
import { eq } from "drizzle-orm";
import { requireAuthOrApiKeyWithOrg } from "@/lib/auth";
import { charactersService } from "@/lib/services/characters/characters";
import { logger } from "@/lib/utils/logger";

const PublishSchema = z.object({
  // Optional: enable monetization when publishing
  enableMonetization: z.boolean().optional().default(false),
  // Optional: set markup percentage (default 0%)
  markupPercentage: z.number().min(0).max(1000).optional().default(0),
  // Optional: payout wallet address
  payoutWalletAddress: z.string().optional(),
  // Optional: enable A2A protocol (default true)
  a2aEnabled: z.boolean().optional().default(true),
  // Optional: enable MCP protocol (default true)
  mcpEnabled: z.boolean().optional().default(true),
});

/**
 * POST /api/v1/agents/[agentId]/publish
 * Publishes an agent (makes it public).
 *
 * This will:
 * 1. Make the agent public (is_public = true)
 * 2. Optionally enable monetization with specified markup
 * 3. Enable A2A and MCP protocols
 *
 * The agent will be discoverable by other agents via:
 * - A2A: /api/agents/{id}/a2a
 * - MCP: /api/agents/{id}/mcp
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> },
) {
  const { user } = await requireAuthOrApiKeyWithOrg(request);
  const { agentId } = await params;

  // Get agent
  const agent = await charactersService.getById(agentId);
  if (!agent) {
    return NextResponse.json(
      { success: false, error: "Agent not found" },
      { status: 404 },
    );
  }

  // Check ownership
  if (agent.user_id !== user.id) {
    return NextResponse.json(
      { success: false, error: "Not authorized to publish this agent" },
      { status: 403 },
    );
  }

  // Parse request body
  let body: z.infer<typeof PublishSchema> = {
    enableMonetization: false,
    markupPercentage: 0,
    a2aEnabled: true,
    mcpEnabled: true,
  };

  try {
    const rawBody = await request.json();
    const validation = PublishSchema.safeParse(rawBody);
    if (validation.success) {
      body = validation.data;
    }
  } catch {
    // Empty body is fine, use defaults
  }

  logger.info("[Agent Publish API] Publishing agent", {
    agentId,
    userId: user.id,
    enableMonetization: body.enableMonetization,
    markupPercentage: body.markupPercentage,
  });

  // Check if already published
  if (agent.is_public) {
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";
    return NextResponse.json({
      success: true,
      message: "Agent is already published",
      agent: {
        id: agent.id,
        name: agent.name,
        isPublic: agent.is_public,
        a2aEndpoint: `${baseUrl}/api/agents/${agent.id}/a2a`,
        mcpEndpoint: `${baseUrl}/api/agents/${agent.id}/mcp`,
      },
    });
  }

  // Update agent to public with settings
  await dbWrite
    .update(userCharacters)
    .set({
      is_public: true,
      a2a_enabled: body.a2aEnabled,
      mcp_enabled: body.mcpEnabled,
      monetization_enabled: body.enableMonetization,
      inference_markup_percentage: String(body.markupPercentage),
      ...(body.payoutWalletAddress && {
        payout_wallet_address: body.payoutWalletAddress,
      }),
      updated_at: new Date(),
    })
    .where(eq(userCharacters.id, agentId));

  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || "https://elizacloud.ai";

  logger.info("[Agent Publish API] Agent published", {
    agentId,
    userId: user.id,
  });

  return NextResponse.json({
    success: true,
    message: "Agent published successfully",
    agent: {
      id: agentId,
      name: agent.name,
      isPublic: true,
      monetizationEnabled: body.enableMonetization,
      markupPercentage: body.markupPercentage,
      a2aEnabled: body.a2aEnabled,
      mcpEnabled: body.mcpEnabled,
      a2aEndpoint: `${baseUrl}/api/agents/${agentId}/a2a`,
      mcpEndpoint: `${baseUrl}/api/agents/${agentId}/mcp`,
    },
  });
}

/**
 * DELETE /api/v1/agents/[agentId]/publish
 * Unpublishes an agent (makes it private).
 */
export async function DELETE(
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

  if (agent.user_id !== user.id) {
    return NextResponse.json(
      { success: false, error: "Not authorized" },
      { status: 403 },
    );
  }

  // Make agent private
  await dbWrite
    .update(userCharacters)
    .set({
      is_public: false,
      monetization_enabled: false,
      updated_at: new Date(),
    })
    .where(eq(userCharacters.id, agentId));

  logger.info("[Agent Publish API] Agent unpublished", {
    agentId,
    userId: user.id,
  });

  return NextResponse.json({
    success: true,
    message: "Agent unpublished",
    agent: {
      id: agentId,
      name: agent.name,
      isPublic: false,
    },
  });
}
